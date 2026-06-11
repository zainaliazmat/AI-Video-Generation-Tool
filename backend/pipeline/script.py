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

SYSTEM_PROMPT = (
    "You are a scriptwriter for short-form faceless videos (vertical, ~60-90s). "
    "Respond ONLY with a JSON object of the form "
    '{"title": string, "beats": Beat[], "hook_candidates"?: Hook[]} where a Beat is '
    '{"text": string, "data"?: object, "keywords"?: string, "source"?: string} '
    'and a Hook is {"text": string, "pattern": string, "source"?: string}. '
    "Each beat's `text` is ONE spoken narration sentence (8-18 words). Produce 5-8 beats. "
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
    "When grounding SOURCES are provided in the user message, state ONLY facts those "
    'sources support and set each factual beat\'s "source" to the exact URL of the '
    "specific source that backs it; never invent a URL or an unsupported fact. "
    "No emojis, no markdown, no numbering."
)

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


def _parse_with_retry(do_call) -> BeatsScript:
    """Call the LLM (do_call -> raw content str), parse+validate, retry once."""
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


def generate_script(
    topic: str, *, provider: str | None = None, client=None, model: str | None = None,
    evidence_block: str | None = None, extra_user_block: str | None = None,
) -> BeatsScript:
    """Pure LLM generation. `evidence_block` (optional) injects retrieved grounding
    sources into the prompt; `generate_grounded_script` is the grounded entry point.
    `extra_user_block` is the Studio v2 additive seam (style memory + feedback)."""
    provider = provider or get_env("LLM_PROVIDER", "deepseek")
    if provider == "deepseek":
        return _generate_openai_compatible(
            topic, client=client, model=model, evidence_block=evidence_block,
            extra_user_block=extra_user_block,
            default_model="deepseek-v4-flash",
            api_key_env="DEEPSEEK_API_KEY",
            base_url=get_env("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
            model_env="DEEPSEEK_MODEL",
        )
    if provider == "ollama":
        return _generate_openai_compatible(
            topic, client=client, model=model, evidence_block=evidence_block,
            extra_user_block=extra_user_block,
            default_model="llama3.1",
            api_key_env=None,
            base_url=get_env("OLLAMA_BASE_URL", "http://localhost:11434") + "/v1",
            model_env="OLLAMA_MODEL",
        )
    if provider == "anthropic":
        return _generate_anthropic(topic, client=client, model=model,
                                   evidence_block=evidence_block, extra_user_block=extra_user_block)
    raise ValueError(f"Unknown LLM_PROVIDER: {provider!r}")


def _generate_openai_compatible(topic, *, client, model, default_model, api_key_env, base_url, model_env, evidence_block=None, extra_user_block=None) -> BeatsScript:
    if client is None:
        from openai import OpenAI
        api_key = require_env(api_key_env) if api_key_env else "ollama"
        client = OpenAI(api_key=api_key, base_url=base_url)
    model = model or get_env(model_env, default_model)

    def do_call() -> str:
        resp = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": build_user_prompt(topic, evidence_block, extra_user_block)},
            ],
            response_format={"type": "json_object"},
            temperature=0.8,
        )
        return resp.choices[0].message.content

    return _parse_with_retry(do_call)


def _generate_anthropic(topic, *, client, model, evidence_block=None, extra_user_block=None) -> BeatsScript:
    if client is None:
        import anthropic
        client = anthropic.Anthropic(api_key=require_env("ANTHROPIC_API_KEY"))
    model = model or get_env("ANTHROPIC_MODEL", "claude-sonnet-4-6")

    def do_call() -> str:
        msg = client.messages.create(
            model=model,
            max_tokens=1024,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": build_user_prompt(topic, evidence_block, extra_user_block)}],
        )
        return msg.content[0].text

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
) -> BeatsScript:
    """Retrieval-grounded generation (3.1) + hook selection (3.2) + verification (3.3).

    Tavily-search the topic, generate beats grounded in the retrieved material,
    enforce that any citation is a URL we actually retrieved, pick the strongest
    hook, then (default-on, `verify=False` to skip for reach-only runs) verify each
    claim is actually supported. `retrieve_fn`/`verify_fn` are injectable so this
    runs fully offline in tests; the LLM provider stays DeepSeek. `extra_user_block`
    is the Studio v2 additive seam (style memory + regenerate feedback)."""
    retrieve_fn = retrieve_fn or retrieval.retrieve
    ctx = retrieve_fn(topic, key=retrieval_key, cache_dir=cache_dir)
    script = generate_script(
        topic, provider=provider, client=client, model=model, evidence_block=ctx.prompt_block(),
        extra_user_block=extra_user_block,
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
