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
from pipeline.content import BeatsScript, parse_beats_response

SYSTEM_PROMPT = (
    "You are a scriptwriter for short-form faceless videos (vertical, ~60-90s). "
    "Respond ONLY with a JSON object of the form "
    '{"title": string, "beats": Beat[]} where a Beat is '
    '{"text": string, "data"?: object, "keywords"?: string}. '
    "Each beat's `text` is ONE spoken narration sentence (8-18 words). Produce 5-8 beats. "
    "The FIRST beat must be a punchy hook that opens the video; the LAST beat must be a "
    "closing call to action (e.g. follow for more). "
    'For any beat whose point is a single striking number or statistic, include '
    '"data": {"value": "<the number, e.g. 90%>", "label": "<short context, 2-5 words>"}. '
    'Optionally add "keywords": "<2-4 words>" to a beat to guide stock-footage search. '
    "No emojis, no markdown, no numbering."
)

MAX_RETRIES = 1  # one retry on an invalid reply, then fail loudly (6.1 v1)


def build_user_prompt(topic: str) -> str:
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


def generate_script(topic: str, *, provider: str | None = None, client=None, model: str | None = None) -> BeatsScript:
    provider = provider or get_env("LLM_PROVIDER", "deepseek")
    if provider == "deepseek":
        return _generate_openai_compatible(
            topic, client=client, model=model,
            default_model="deepseek-v4-flash",
            api_key_env="DEEPSEEK_API_KEY",
            base_url=get_env("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
            model_env="DEEPSEEK_MODEL",
        )
    if provider == "ollama":
        return _generate_openai_compatible(
            topic, client=client, model=model,
            default_model="llama3.1",
            api_key_env=None,
            base_url=get_env("OLLAMA_BASE_URL", "http://localhost:11434") + "/v1",
            model_env="OLLAMA_MODEL",
        )
    if provider == "anthropic":
        return _generate_anthropic(topic, client=client, model=model)
    raise ValueError(f"Unknown LLM_PROVIDER: {provider!r}")


def _generate_openai_compatible(topic, *, client, model, default_model, api_key_env, base_url, model_env) -> BeatsScript:
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
                {"role": "user", "content": build_user_prompt(topic)},
            ],
            response_format={"type": "json_object"},
            temperature=0.8,
        )
        return resp.choices[0].message.content

    return _parse_with_retry(do_call)


def _generate_anthropic(topic, *, client, model) -> BeatsScript:
    if client is None:
        import anthropic
        client = anthropic.Anthropic(api_key=require_env("ANTHROPIC_API_KEY"))
    model = model or get_env("ANTHROPIC_MODEL", "claude-sonnet-4-6")

    def do_call() -> str:
        msg = client.messages.create(
            model=model,
            max_tokens=1024,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": build_user_prompt(topic)}],
        )
        return msg.content[0].text

    return _parse_with_retry(do_call)


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--topic", required=True)
    args = ap.parse_args()
    print(json.dumps(generate_script(args.topic).model_dump(), indent=2))
