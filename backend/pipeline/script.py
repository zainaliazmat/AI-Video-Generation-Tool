"""Stage 1 — generate structured short-form video CONTENT via a pluggable LLM.

Emits a `BeatsScript` (title + narration beats, each with optional structured
`data`/`keywords`) — NOT a template plan. The model never names a template
`kind`; the recipe/director (step 6.2) derives slot/template deterministically
from beat position + data shape. Validated by Pydantic (`pipeline.content`), with
a single retry on an invalid reply, so the guarantee is provider-portable.

LLM_PROVIDER: deepseek (default) | ollama | anthropic.
Run standalone:  python backend/pipeline/script.py --topic "3 facts about octopuses"
"""
from __future__ import annotations

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))  # backend/

import json

import re

from pipeline.config import get_env, require_env
from pipeline.content import Beat, BeatsScript, HookCandidate, Source, parse_beats_response
from pipeline import retrieval
from pipeline import verify as verify_stage

# ---------------------------------------------------------------------------
# SYSTEM_PROMPT segments (D1-B surgery, Studio v3 M2)
# ---------------------------------------------------------------------------
# The prompt is split into named segments that concatenate back to the original
# SYSTEM_PROMPT byte-for-byte when target_length=60 (D1-B golden test).
#
# Original sentence layout (preserved in full by system_prompt_for):
#   _intro_sentence(p)   — "You are a scriptwriter … (~60-90s). "
#   _JSON_SCHEMA_BLOCK   — "Respond ONLY with a JSON object …"
#   _beats_sentence(p)   — "Each beat's `text` is ONE … Produce 5-8 beats. "
#   _STRUCTURE_SEGMENT   — "Pace for retention … never put both on one beat. "
#   KEYWORD_RULE_SEGMENT — ① keyword-rule block (never varies)
#   GROUNDING_SEGMENT    — citation / grounding rules (never varies)

# Constant: JSON response-schema declaration (lines 30-33 of the original prompt).
_JSON_SCHEMA_BLOCK = (
    "Respond ONLY with a JSON object of the form "
    '{"title": string, "beats": Beat[], "hook_candidates"?: Hook[]} where a Beat is '
    '{"text": string, "data"?: object, "keywords"?: string, "source"?: string} '
    'and a Hook is {"text": string, "pattern": string, "source"?: string}. '
)

# Constant: structural beat/data rules that follow the beats-count sentence.
_STRUCTURE_SEGMENT = (
    "Pace for retention: open tight, deliver a clear payoff, no filler or dead air. "
    "The FIRST beat must be a punchy hook that opens the video; the LAST beat must be a "
    "closing call to action (e.g. follow for more). "
    "The title must NOT promise a fixed count (avoid 'N facts ...') — unverifiable facts may be dropped. "
    'For any beat whose point is a single striking number or statistic, include '
    '"data": {"value": "<the number, e.g. 90%>", "label": "<short context, 2-5 words>"}. '
    'For any beat that NAMES a small enumerable SET of things (2-6 items, e.g. '
    '"the sun, the moon, the planets"), instead include '
    '"data": {"items": ["<item1>", "<item2>", ...]} with the bare item nouns in the SAME '
    "ORDER the narration speaks them, and make the beat `text` actually name each item in "
    "that order. Use `items` for an enumerable set, NOT for a single statistic (that is "
    "`value`/`label`); never put both on one beat. "
)

# Segment ①: keyword-rule block — byte-identical across ALL presets.
KEYWORD_RULE_SEGMENT = (
    'For EVERY beat, add "keywords": "<2-4 words>" for stock-footage search. GUIDING PRINCIPLE: '
    'pick words whose DOMINANT stock-footage meaning IS your subject — a stock library returns '
    'the COMMON sense of a phrase, not the one you intended. Apply it: '
    '(a) name a CONCRETE, FILMABLE thing on screen, never an abstract concept ("melting glacier", '
    'not "economic growth" or "freedom"); '
    '(b) LEAD WITH THE CONCRETE NOUN, never a process word — a process-led phrase drifts to the '
    'wrong scene ("ocean evaporation steam" returns a geothermal vent; use "sea spray over waves"); '
    '(c) never use a compound whose everyday meaning is a DIFFERENT object than you mean — it '
    'returns that other object ("hand crank" returns a coffee grinder; name the visible part: '
    '"brass clockwork gears"); '
    '(d) for a subject too specific for stock — a named place, person, event, branded object, or '
    'niche instrument — use an ANONYMOUS filmable category or mood that evokes it, NEVER a named '
    'landmark a viewer would recognize ("celestial globe" or "the Antikythera mechanism" -> '
    '"antique astronomical instrument", not a famous astronomical clock; "Challenger Deep" -> '
    '"dark ocean abyss"; "Nobel medal" -> "physics laboratory"). '
)

# Segment ②: grounding / citation rules — byte-identical across ALL presets.
GROUNDING_SEGMENT = (
    "When grounding SOURCES are provided in the user message, state ONLY facts those "
    'sources support and set each factual beat\'s "source" to the exact URL of the '
    "specific source that backs it; never invent a URL or an unsupported fact. "
    "No emojis, no markdown, no numbering."
)

# ---------------------------------------------------------------------------
# Length presets (OV-3: 60s band is 5-8 beats, matching the frozen prompt)
# Fields used by system_prompt_for():
#   duration_desc  — "~60-90s" style wording for the intro sentence
#   beat_min       — minimum beat count
#   beat_max       — maximum beat count
#   wpb_min        — words-per-beat minimum
#   wpb_max        — words-per-beat maximum
#   sentence_desc  — "ONE spoken narration sentence" or "one to two spoken …"
# ---------------------------------------------------------------------------
LENGTH_PRESETS: dict[int, dict] = {
    30: {
        "duration_desc": "~30s",
        "beat_min": 5,
        "beat_max": 6,
        "wpb_min": 8,
        "wpb_max": 18,
        "sentence_desc": "ONE spoken narration sentence",
    },
    60: {
        # OV-3: 5-8 beats matches the frozen prompt's "Produce 5-8 beats";
        # PRD §5.0's 7-9 was a drafting artifact — band 5-8 is normative.
        "duration_desc": "~60-90s",
        "beat_min": 5,
        "beat_max": 8,
        "wpb_min": 8,
        "wpb_max": 18,
        "sentence_desc": "ONE spoken narration sentence",
    },
    180: {
        "duration_desc": "~2-3 minutes",
        "beat_min": 22,
        "beat_max": 30,
        "wpb_min": 15,
        "wpb_max": 45,
        "sentence_desc": "one to two spoken narration sentences",
    },
    300: {
        "duration_desc": "~4-5 minutes",
        "beat_min": 38,
        "beat_max": 48,
        "wpb_min": 15,
        "wpb_max": 45,
        "sentence_desc": "one to two spoken narration sentences",
    },
}


def system_prompt_for(target_length: int) -> str:
    """Return the full system prompt parametrized for `target_length` seconds.

    Raises KeyError if `target_length` is not in LENGTH_PRESETS (codebase idiom).
    SYSTEM_PROMPT == system_prompt_for(60) — byte-identical (D1-B golden test).

    Sentence order mirrors the original frozen prompt exactly:
      intro_sentence → JSON schema → beats_sentence → structure → keywords → grounding
    """
    p = LENGTH_PRESETS[target_length]  # KeyError on unknown length — codebase idiom
    intro = (
        f"You are a scriptwriter for short-form faceless videos (vertical, {p['duration_desc']}). "
    )
    beats = (
        f"Each beat's `text` is {p['sentence_desc']} ({p['wpb_min']}-{p['wpb_max']} words). "
        f"Produce {p['beat_min']}-{p['beat_max']} beats. "
    )
    return intro + _JSON_SCHEMA_BLOCK + beats + _STRUCTURE_SEGMENT + KEYWORD_RULE_SEGMENT + GROUNDING_SEGMENT


# SYSTEM_PROMPT: module-level constant preserved for all existing importers.
# Byte-identical to system_prompt_for(60) — verified by test_system_prompt_golden_60.
SYSTEM_PROMPT = system_prompt_for(60)

VERIFY_SYSTEM_PROMPT = (
    "You are a strict fact-checker. Each item has a CLAIM, an optional on-screen "
    "VALUE (a number), and candidate SOURCES (snippets with URLs). Respond ONLY with "
    'JSON {"verdicts": Verdict[]} where a Verdict is {"index": int, '
    '"claim_supported": bool, "number_supported": bool|null, "source": string|null}. '
    "Set claim_supported true ONLY if a SOURCE snippet actually states the claim. If a "
    "VALUE is given, set number_supported true only if a snippet states that exact "
    "number, else false; use null when no VALUE is given. Set source to the URL of the "
    "snippet that best supports the claim (or null). Judge ONLY from the snippets given; "
    "never use outside knowledge. Return a verdict for EVERY item index."
)

MAX_RETRIES = 1  # one retry on an invalid reply, then fail loudly (6.1 v1)


def _corrective_suffix(got: int, beat_min: int, beat_max: int) -> str:
    """Return the corrective line appended to the USER message on a band-miss retry.
    Appended to the user prompt ONLY — the system prompt is never touched."""
    return (
        f"\n\nYour previous response had {got} beats; "
        f"produce between {beat_min} and {beat_max} beats."
    )


def _parse_with_retry(do_call) -> "BeatsScript":
    """Call the LLM (do_call -> raw content str), parse+validate, retry once.

    Legacy entry point (used when target_length is None / not given): parse failures
    get one retry, then fail loudly. Band checking is NOT performed here — it lives
    in _generate_with_band_retry which is the unified entry point for preset-aware
    generation. Both share the same MAX_RETRIES=1 budget."""
    last_err: Exception | None = None
    for _ in range(MAX_RETRIES + 1):
        content = do_call()
        try:
            return parse_beats_response(content)
        except ValueError as e:  # bad JSON or schema violation
            last_err = e
    raise ValueError(
        f"LLM script response invalid after {MAX_RETRIES + 1} attempts: {last_err}"
    )


def _generate_with_band_retry(
    do_call,
    make_corrective_call,
    target_length: int,
) -> "BeatsScript":
    """Unified retry for band-and-parse failures (M2-T3, OV-8).

    ONE bounded extra attempt for BOTH band misses and malformed/truncated JSON —
    parse failure and band miss share the same single retry budget (never stacked).

    Attempt 1  —  plain do_call():
      • parse error  → attempt 2 (no corrective line — the failure is formatting)
      • success, in-band  → return, no band_miss
      • success, out-of-band  → attempt 2 WITH corrective user line

    Attempt 2  —  make_corrective_call(suffix: str):
      • parse error  → raise ValueError with a clean "unparseable JSON" message
      • success, in-band  → return, no band_miss
      • success, out-of-band  → return as-is, set band_miss on the script

    The system prompt is NEVER modified; the corrective line goes into the USER
    message only (via make_corrective_call receiving the suffix string).
    """
    preset = LENGTH_PRESETS[target_length]
    beat_min, beat_max = preset["beat_min"], preset["beat_max"]

    # --- Attempt 1 ---
    try:
        script1 = parse_beats_response(do_call())
    except ValueError:
        # Parse failure on attempt 1 — retry with no corrective line (just re-ask).
        try:
            script2 = parse_beats_response(make_corrective_call(""))
        except ValueError as e:
            raise ValueError(
                f"script generation returned unparseable JSON twice: {e}"
            ) from e
        n2 = len(script2.beats)
        if beat_min <= n2 <= beat_max:
            return script2
        script2.band_miss = {"requested": [beat_min, beat_max], "got": n2}
        return script2

    # --- Attempt 1 succeeded: check band ---
    n1 = len(script1.beats)
    if beat_min <= n1 <= beat_max:
        return script1

    # Out-of-band: retry WITH corrective line.
    suffix = _corrective_suffix(n1, beat_min, beat_max)
    try:
        script2 = parse_beats_response(make_corrective_call(suffix))
    except ValueError:
        # Attempt 2 unparseable after attempt 1 was valid but out-of-band:
        # return the parseable attempt-1 script with band_miss rather than
        # raising — an out-of-band-but-valid script beats a dead stage.
        script1.band_miss = {"requested": [beat_min, beat_max], "got": n1}
        return script1
    n2 = len(script2.beats)
    if beat_min <= n2 <= beat_max:
        return script2
    script2.band_miss = {"requested": [beat_min, beat_max], "got": n2}
    return script2


def build_user_prompt(topic: str, evidence_block: str | None = None,
                      extra_user_block: str | None = None) -> str:
    # extra_user_block is the Studio v2 additive seam (style memory + regenerate
    # feedback). It is appended to the USER message only — the frozen SYSTEM_PROMPT
    # and the grounding rules above are never rewritten.
    tail = f"\n\n{extra_user_block.strip()}" if extra_user_block and extra_user_block.strip() else ""
    if evidence_block:
        return (
            f"Topic: {topic}\n\n"
            "Ground every factual claim in the SOURCES below.\n"
            "- State ONLY a claim that a specific source snippet below supports. If you cannot pin "
            "a claim to a snippet, OMIT it — a shorter, fully-grounded script beats a padded one.\n"
            '- Set each factual beat\'s "source" to the exact URL of the ONE source whose snippet '
            "actually contains that claim; prefer the snippet that states it, and do not reuse one "
            "source for a claim it does not cover.\n"
            "- Never invent a URL, a number, or a fact.\n"
            '- Also return 3-4 "hook_candidates": punchy one-line openers, each grounded in ONE fact '
            'above (set its "source") and spanning different patterns (curiosity gap, surprising '
            "stat, bold claim, direct question) — the most striking TRUE fact framed to stop the "
            "scroll, never invented.\n"
            "- Each fact/stat must add NEW information — do not restate the fact used in the hook.\n\n"
            f"SOURCES:\n{evidence_block}{tail}\n\n"
            "Return the JSON object now."
        )
    return f"Topic: {topic}{tail}\nReturn the JSON object now."


def generate_script(
    topic: str, *, provider: str | None = None, client=None, model: str | None = None,
    evidence_block: str | None = None, extra_user_block: str | None = None,
    system_prompt: str | None = None, target_length: int | None = None,
) -> BeatsScript:
    """Pure LLM generation. `evidence_block` (optional) injects retrieved grounding
    sources into the prompt; `generate_grounded_script` is the grounded entry point.
    `extra_user_block` is the Studio v2 additive seam (style memory + feedback).
    `system_prompt` (Studio v3 M2) overrides the system prompt for the selected
    length preset; defaults to SYSTEM_PROMPT when None (byte-identical to 60s).
    `target_length` (M2-T3, OV-8) enables unified beat-band + parse retry: if set,
    uses _generate_with_band_retry instead of _parse_with_retry so parse failures
    and band misses share the same single retry budget (never stacked)."""
    sp = system_prompt if system_prompt is not None else SYSTEM_PROMPT
    provider = provider or get_env("LLM_PROVIDER", "deepseek")
    if provider == "deepseek":
        return _generate_openai_compatible(
            topic, client=client, model=model, evidence_block=evidence_block,
            extra_user_block=extra_user_block, system_prompt=sp,
            default_model="deepseek-v4-flash",
            api_key_env="DEEPSEEK_API_KEY",
            base_url=get_env("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
            model_env="DEEPSEEK_MODEL",
            target_length=target_length,
        )
    if provider == "ollama":
        return _generate_openai_compatible(
            topic, client=client, model=model, evidence_block=evidence_block,
            extra_user_block=extra_user_block, system_prompt=sp,
            default_model="llama3.1",
            api_key_env=None,
            base_url=get_env("OLLAMA_BASE_URL", "http://localhost:11434") + "/v1",
            model_env="OLLAMA_MODEL",
            target_length=target_length,
        )
    if provider == "anthropic":
        return _generate_anthropic(topic, client=client, model=model,
                                   evidence_block=evidence_block, extra_user_block=extra_user_block,
                                   system_prompt=sp, target_length=target_length)
    raise ValueError(f"Unknown LLM_PROVIDER: {provider!r}")


def _generate_openai_compatible(topic, *, client, model, default_model, api_key_env, base_url, model_env, evidence_block=None, extra_user_block=None, system_prompt=None, target_length=None) -> BeatsScript:
    if client is None:
        from openai import OpenAI
        api_key = require_env(api_key_env) if api_key_env else "ollama"
        client = OpenAI(api_key=api_key, base_url=base_url)
    model = model or get_env(model_env, default_model)
    sp = system_prompt if system_prompt is not None else SYSTEM_PROMPT

    def do_call() -> str:
        resp = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": sp},
                {"role": "user", "content": build_user_prompt(topic, evidence_block, extra_user_block)},
            ],
            response_format={"type": "json_object"},
            temperature=0.8,
        )
        return resp.choices[0].message.content

    if target_length is not None:
        # M2-T3: unified band+parse retry — parse failure and band miss share one budget.
        def make_corrective_call(suffix: str) -> str:
            tail = (extra_user_block or "") + suffix
            resp = client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": sp},
                    {"role": "user", "content": build_user_prompt(topic, evidence_block, tail or None)},
                ],
                response_format={"type": "json_object"},
                temperature=0.8,
            )
            return resp.choices[0].message.content

        return _generate_with_band_retry(do_call, make_corrective_call, target_length)

    return _parse_with_retry(do_call)


def _generate_anthropic(topic, *, client, model, evidence_block=None, extra_user_block=None, system_prompt=None, target_length=None) -> BeatsScript:
    if client is None:
        import anthropic
        client = anthropic.Anthropic(api_key=require_env("ANTHROPIC_API_KEY"))
    model = model or get_env("ANTHROPIC_MODEL", "claude-sonnet-4-6")
    sp = system_prompt if system_prompt is not None else SYSTEM_PROMPT

    def do_call() -> str:
        msg = client.messages.create(
            model=model,
            max_tokens=1024,
            system=sp,
            messages=[{"role": "user", "content": build_user_prompt(topic, evidence_block, extra_user_block)}],
        )
        return msg.content[0].text

    if target_length is not None:
        def make_corrective_call(suffix: str) -> str:
            tail = (extra_user_block or "") + suffix
            msg = client.messages.create(
                model=model,
                max_tokens=1024,
                system=sp,
                messages=[{"role": "user", "content": build_user_prompt(topic, evidence_block, tail or None)}],
            )
            return msg.content[0].text

        return _generate_with_band_retry(do_call, make_corrective_call, target_length)

    return _parse_with_retry(do_call)


def generate_grounded_script(
    topic: str,
    *,
    provider: str | None = None,
    client=None,
    model: str | None = None,
    retrieve_fn=None,
    retrieval_key: str | None = None,
    cache_dir=None,
    verify: bool = True,
    verify_fn=None,
    extra_user_block: str | None = None,
    system_prompt: str | None = None,
    target_length: int | None = None,
) -> BeatsScript:
    """Retrieval-grounded generation (3.1) + hook selection (3.2) + verification (3.3).

    Tavily-search the topic, generate beats grounded in the retrieved material,
    enforce that any citation is a URL we actually retrieved, pick the strongest
    hook, then (default-on, `verify=False` to skip for reach-only runs) verify each
    claim is actually supported. `retrieve_fn`/`verify_fn` are injectable so this
    runs fully offline in tests; the LLM provider stays DeepSeek. `extra_user_block`
    is the Studio v2 additive seam (style memory + regenerate feedback).
    `system_prompt` (Studio v3 M2) overrides the system prompt for the selected
    length preset; defaults to SYSTEM_PROMPT when None.
    `target_length` (M2-T3) enables the unified beat-band + parse retry; when set,
    generate_script uses _generate_with_band_retry instead of _parse_with_retry."""
    retrieve_fn = retrieve_fn or retrieval.retrieve
    ctx = retrieve_fn(topic, key=retrieval_key, cache_dir=cache_dir)
    script = generate_script(
        topic, provider=provider, client=client, model=model, evidence_block=ctx.prompt_block(),
        extra_user_block=extra_user_block, system_prompt=system_prompt,
        target_length=target_length,
    )
    _select_hook(script, ctx)
    _enforce_grounding(script, ctx)
    if verify:
        vfn = verify_fn or _build_verify_fn(provider=provider, client=client, model=model)
        verify_stage.verify_script(
            script, ctx, verify_fn=vfn, retrieve_fn=retrieve_fn,
            retrieval_key=retrieval_key, cache_dir=cache_dir,
        )
        _reselect_hook_if_dropped(script, ctx, vfn)
        _enforce_floor(script)
    script.title = _count_agnostic_title(script.title)
    return script


def _enforce_grounding(script: BeatsScript, ctx) -> BeatsScript:
    """Strict grounding: drop any beat citation that isn't a URL we actually
    retrieved, and set `script.sources` to the de-duped set of real cited sources."""
    valid = ctx.urls
    title_by_url = {s.url: s.title for s in ctx.snippets}
    cited: list[Source] = []
    seen: set[str] = set()
    for beat in script.beats:
        if beat.source and beat.source not in valid:
            beat.source = None  # cited something we never retrieved → not trustworthy
        if beat.source and beat.source not in seen:
            seen.add(beat.source)
            cited.append(Source(url=beat.source, title=title_by_url.get(beat.source)))
    script.sources = cited or None
    return script


def _score_hook(c: HookCandidate) -> float:
    """Deterministic strength of an opening hook (3.2). A concrete number hooks
    hardest; a question opens a curiosity gap; a real grounded source and a punchy
    length help. Reproducible, like the recipe — and tunable in one place."""
    text = c.text or ""
    words = text.split()
    score = 0.0
    if any(ch.isdigit() for ch in text):
        score += 2.0          # a concrete number/stat stops the scroll hardest
    if text.rstrip().endswith("?"):
        score += 1.0          # curiosity gap / direct question
    if c.source:
        score += 1.0          # grounded in a real retrieved source
    if 6 <= len(words) <= 14:
        score += 1.0          # punchy length
    return score


def _select_hook(script: BeatsScript, ctx) -> BeatsScript:
    """Pick the strongest opening hook and make it beat 0 (Phase 3.2).

    The model's hook candidates AND its own opening beat compete. Bogus citations
    are dropped first (so only truly-grounded hooks earn the grounding bonus), each
    is scored, the winner becomes beat 0, and the full scored pool is retained on
    `hook_candidates` for inspection / later override (auto-pick with override)."""
    if not script.beats:
        return script
    head = script.beats[0]
    pool = list(script.hook_candidates or [])
    pool.append(HookCandidate(text=head.text, pattern="default", source=head.source))
    valid = ctx.urls
    for c in pool:
        if c.source and c.source not in valid:
            c.source = None       # a non-retrieved citation is no citation
        c.score = _score_hook(c)
    best = max(pool, key=lambda c: c.score)   # first max wins → a real candidate beats the default on ties
    for c in pool:
        c.chosen = c is best
    head.text = best.text
    head.source = best.source
    script.hook_candidates = pool
    return script


def _openai_client_and_model(provider, client, model):
    """(client, model) for an OpenAI-compatible provider — used by the verifier."""
    if provider == "ollama":
        base, key = get_env("OLLAMA_BASE_URL", "http://localhost:11434") + "/v1", "ollama"
        model = model or get_env("OLLAMA_MODEL", "llama3.1")
    else:  # deepseek (default)
        base, key = get_env("DEEPSEEK_BASE_URL", "https://api.deepseek.com"), require_env("DEEPSEEK_API_KEY")
        model = model or get_env("DEEPSEEK_MODEL", "deepseek-v4-flash")
    if client is None:
        from openai import OpenAI
        client = OpenAI(api_key=key, base_url=base)
    return client, model


def _build_verify_fn(*, provider=None, client=None, model=None):
    """Default claim verifier: ONE batched LLM call (same provider as generation,
    DeepSeek by default) judging each claim against its candidate snippets. Injected
    into verify_script; tests pass their own fake, so this runs only on real E2E."""
    provider = provider or get_env("LLM_PROVIDER", "deepseek")

    def verify_fn(items):
        user = "Verify these items:\n" + json.dumps(items)
        if provider == "anthropic":
            import anthropic
            ac = client or anthropic.Anthropic(api_key=require_env("ANTHROPIC_API_KEY"))
            m = model or get_env("ANTHROPIC_MODEL", "claude-sonnet-4-6")
            msg = ac.messages.create(
                model=m, max_tokens=1500, system=VERIFY_SYSTEM_PROMPT,
                messages=[{"role": "user", "content": user}],
            )
            content = msg.content[0].text
        else:
            c, m = _openai_client_and_model(provider, client, model)
            resp = c.chat.completions.create(
                model=m,
                messages=[
                    {"role": "system", "content": VERIFY_SYSTEM_PROMPT},
                    {"role": "user", "content": user},
                ],
                response_format={"type": "json_object"},
                temperature=0,
            )
            content = resp.choices[0].message.content
        return json.loads(content).get("verdicts", [])

    return verify_fn


_COUNT_PREFIX = re.compile(r"^\s*(?:top\s+)?\d+\s+", re.IGNORECASE)


def _count_agnostic_title(title: str) -> str:
    """Strip a leading count ('3 ', 'Top 5 ') so a dropped fact never leaves the
    title promising more than the video delivers (Phase 3.3 floor handling)."""
    return _COUNT_PREFIX.sub("", title, count=1).strip() or title


def _reselect_hook_if_dropped(script: BeatsScript, ctx, verify_fn) -> None:
    """If verification dropped the chosen hook, promote the next-best GROUNDED hook
    candidate that verifies (ONE batched re-check), else fall back to the title — a
    non-asserting opener with no claim to fail (Phase 3.3 hook-drop policy)."""
    cands = script.hook_candidates or []
    chosen = next((c for c in cands if c.chosen), None)
    if not chosen or not script.beats or script.beats[0].text == chosen.text:
        return  # no hook selection, or the chosen hook survived verification
    alts = sorted((c for c in cands if c is not chosen and c.source), key=lambda c: c.score or 0, reverse=True)
    if alts:
        snippets = [{"url": s.url, "content": s.content} for s in ctx.snippets]
        items = [{"index": j, "claim": c.text, "value": None, "snippets": snippets} for j, c in enumerate(alts)]
        verdicts = {v["index"]: v for v in verify_fn(items)}
        for j, c in enumerate(alts):
            v = verdicts.get(j)
            if v and v.get("claim_supported"):
                script.beats.insert(0, Beat(text=c.text, source=v.get("source") or c.source))
                return
    script.beats.insert(0, Beat(text=script.title))  # non-asserting fallback


def _enforce_floor(script: BeatsScript) -> None:
    """Two-tier fact floor over surviving body claims — kept AND demoted beats
    (excluding the hook and outro): HARD-FAIL at 0 (refuse a claimless video),
    WARN at 1. Demotions count: a demoted stat keeps its source/claim."""
    n = sum(1 for b in script.beats[1:] if b.source)
    if n == 0:
        raise ValueError(
            "verification left 0 supported claims — refusing to ship a claimless video; "
            "try a richer or more specific topic"
        )
    if n == 1:
        print("[script] warning: only 1 supported claim survived verification — consider a richer topic", file=sys.stderr)


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--topic", required=True)
    args = ap.parse_args()
    print(json.dumps(generate_script(args.topic).model_dump(), indent=2))
