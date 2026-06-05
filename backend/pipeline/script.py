"""Stage 1 — generate a short-form video script via a pluggable LLM provider.

LLM_PROVIDER: deepseek (default) | ollama | anthropic.
Run standalone:  python backend/pipeline/script.py --topic "3 facts about octopuses"
"""
from __future__ import annotations

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))  # backend/

import json

from pipeline.config import get_env, require_env

SYSTEM_PROMPT = (
    "You are a scriptwriter for short-form faceless videos (vertical, ~60-90s). "
    "Write punchy, factual narration. Respond ONLY with a JSON object of the form "
    '{"title": string, "lines": string[]} where each line is one spoken sentence '
    "(8-18 words), 5-8 lines total, no emojis, no markdown, no numbering."
)


def build_user_prompt(topic: str) -> str:
    return f"Topic: {topic}\nReturn the JSON object now."


def parse_script_response(content: str) -> dict:
    data = json.loads(content)
    title = data.get("title")
    lines = data.get("lines")
    if not isinstance(title, str) or not title.strip():
        raise ValueError("Script response missing a non-empty 'title'")
    if (
        not isinstance(lines, list)
        or not lines
        or not all(isinstance(x, str) and x.strip() for x in lines)
    ):
        raise ValueError("Script response 'lines' must be a non-empty list of strings")
    return {"title": title.strip(), "lines": [x.strip() for x in lines]}


def generate_script(topic: str, *, provider: str | None = None, client=None, model: str | None = None) -> dict:
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


def _generate_openai_compatible(topic, *, client, model, default_model, api_key_env, base_url, model_env) -> dict:
    if client is None:
        from openai import OpenAI
        api_key = require_env(api_key_env) if api_key_env else "ollama"
        client = OpenAI(api_key=api_key, base_url=base_url)
    model = model or get_env(model_env, default_model)
    resp = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": build_user_prompt(topic)},
        ],
        response_format={"type": "json_object"},
        temperature=0.8,
    )
    return parse_script_response(resp.choices[0].message.content)


def _generate_anthropic(topic, *, client, model) -> dict:
    if client is None:
        import anthropic
        client = anthropic.Anthropic(api_key=require_env("ANTHROPIC_API_KEY"))
    model = model or get_env("ANTHROPIC_MODEL", "claude-sonnet-4-6")
    msg = client.messages.create(
        model=model,
        max_tokens=1024,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": build_user_prompt(topic)}],
    )
    return parse_script_response(msg.content[0].text)


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--topic", required=True)
    args = ap.parse_args()
    print(json.dumps(generate_script(args.topic), indent=2))
