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

from pipeline.config import get_env, require_env
from pipeline.content import BeatsScript, HookCandidate, Source, parse_beats_response
from pipeline import retrieval

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
    'For any beat whose point is a single striking number or statistic, include '
    '"data": {"value": "<the number, e.g. 90%>", "label": "<short context, 2-5 words>"}. '
    'Optionally add "keywords": "<2-4 words>" to a beat to guide stock-footage search. '
    "When grounding SOURCES are provided in the user message, state ONLY facts those "
    'sources support and set each factual beat\'s "source" to the exact URL of the '
    "specific source that backs it; never invent a URL or an unsupported fact. "
    "No emojis, no markdown, no numbering."
)

MAX_RETRIES = 1  # one retry on an invalid reply, then fail loudly (6.1 v1)


def build_user_prompt(topic: str, evidence_block: str | None = None) -> str:
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
            "scroll, never invented.\n\n"
            f"SOURCES:\n{evidence_block}\n\n"
            "Return the JSON object now."
        )
    return f"Topic: {topic}\nReturn the JSON object now."


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
    evidence_block: str | None = None,
) -> BeatsScript:
    """Pure LLM generation. `evidence_block` (optional) injects retrieved grounding
    sources into the prompt; `generate_grounded_script` is the grounded entry point."""
    provider = provider or get_env("LLM_PROVIDER", "deepseek")
    if provider == "deepseek":
        return _generate_openai_compatible(
            topic, client=client, model=model, evidence_block=evidence_block,
            default_model="deepseek-v4-flash",
            api_key_env="DEEPSEEK_API_KEY",
            base_url=get_env("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
            model_env="DEEPSEEK_MODEL",
        )
    if provider == "ollama":
        return _generate_openai_compatible(
            topic, client=client, model=model, evidence_block=evidence_block,
            default_model="llama3.1",
            api_key_env=None,
            base_url=get_env("OLLAMA_BASE_URL", "http://localhost:11434") + "/v1",
            model_env="OLLAMA_MODEL",
        )
    if provider == "anthropic":
        return _generate_anthropic(topic, client=client, model=model, evidence_block=evidence_block)
    raise ValueError(f"Unknown LLM_PROVIDER: {provider!r}")


def _generate_openai_compatible(topic, *, client, model, default_model, api_key_env, base_url, model_env, evidence_block=None) -> BeatsScript:
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
                {"role": "user", "content": build_user_prompt(topic, evidence_block)},
            ],
            response_format={"type": "json_object"},
            temperature=0.8,
        )
        return resp.choices[0].message.content

    return _parse_with_retry(do_call)


def _generate_anthropic(topic, *, client, model, evidence_block=None) -> BeatsScript:
    if client is None:
        import anthropic
        client = anthropic.Anthropic(api_key=require_env("ANTHROPIC_API_KEY"))
    model = model or get_env("ANTHROPIC_MODEL", "claude-sonnet-4-6")

    def do_call() -> str:
        msg = client.messages.create(
            model=model,
            max_tokens=1024,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": build_user_prompt(topic, evidence_block)}],
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
) -> BeatsScript:
    """Retrieval-grounded generation (3.1).

    Tavily-search the topic, generate beats grounded in the retrieved material,
    then ENFORCE that any citation a beat carries is a URL we actually retrieved —
    citations are trustworthy by construction, not merely present. `retrieve_fn` is
    injectable so this runs fully offline in tests; the LLM provider stays DeepSeek."""
    retrieve_fn = retrieve_fn or retrieval.retrieve
    ctx = retrieve_fn(topic, key=retrieval_key, cache_dir=cache_dir)
    script = generate_script(
        topic, provider=provider, client=client, model=model, evidence_block=ctx.prompt_block()
    )
    _select_hook(script, ctx)
    return _enforce_grounding(script, ctx)


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


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--topic", required=True)
    args = ap.parse_args()
    print(json.dumps(generate_script(args.topic).model_dump(), indent=2))
