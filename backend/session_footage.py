"""Studio v2 Footage gate — suggest a replacement query (PRD §6.4, lever ①).

One LLM call proposes a concrete, filmable stock query for a beat, then the SAME
frozen `harden()` the pipeline uses is applied (collision lexicon + named-entity
guard) so a suggestion can never bypass the ① rule. Read-only: it proposes a query
string; the operator runs re_query (session_edit.py) to actually rebind a clip.

Usage:
  python backend/session_footage.py --sid <id> --op suggest --scene <n>
"""
from __future__ import annotations

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # backend/

import json
from session import store, job_ctx
from pipeline.footage_query import harden

_SYSTEM = (
    "You propose a SHORT stock-footage search query (2-5 words) for a narration beat. "
    "Rules: a concrete, filmable noun whose DOMINANT stock meaning is the target; lead "
    "with the noun; for a niche/abstract subject use a generic visual category or mood; "
    "NEVER a named landmark/person/brand. Output ONLY JSON: {\"query\": \"...\"}."
)


def _topic_for(sid: str) -> str:
    conn = store.connect(job_ctx.SESSIONS_DB)
    try:
        row = store.get_session(conn, sid)
        if row is None:
            raise KeyError(f"no session {sid!r}")
        return row["topic"]
    finally:
        conn.close()


def _beat_text(conn, sid, scene) -> str:
    row = store.get_stage(conn, sid, "script")
    if row and row["output_json"]:
        try:
            beats = json.loads(row["output_json"])["script"]["beats"]
            if 0 <= scene < len(beats):
                return beats[scene].get("text", "")
        except (ValueError, KeyError, TypeError):
            pass
    return ""


def _llm_call(messages) -> str:
    from pipeline.config import get_env, require_env
    from openai import OpenAI
    provider = get_env("LLM_PROVIDER", "deepseek")
    if provider == "ollama":
        client = OpenAI(api_key="ollama", base_url=get_env("OLLAMA_BASE_URL", "http://localhost:11434") + "/v1")
        model = get_env("OLLAMA_MODEL", "llama3.1")
    else:
        client = OpenAI(api_key=require_env("DEEPSEEK_API_KEY"),
                        base_url=get_env("DEEPSEEK_BASE_URL", "https://api.deepseek.com"))
        model = get_env("DEEPSEEK_MODEL", "deepseek-v4-flash")
    resp = client.chat.completions.create(
        model=model, messages=messages, response_format={"type": "json_object"}, temperature=0.4)
    return resp.choices[0].message.content


def suggest(sid: str, *, scene: int, llm=None) -> dict:
    conn = store.connect(job_ctx.SESSIONS_DB)
    try:
        if store.get_session(conn, sid) is None:
            raise KeyError(f"no session {sid!r}")
        beat = _beat_text(conn, sid, scene)
        topic = _topic_for(sid)
        call = llm or _llm_call
        content = call([
            {"role": "system", "content": _SYSTEM},
            {"role": "user", "content": f"Topic: {topic}\nBeat: {beat}\nReturn the JSON."}])
        raw = json.loads(content).get("query", "").strip()
        if not raw:
            raise RuntimeError("model proposed an empty query")
        hardened = harden(raw, title=topic)        # the frozen ① rule, never bypassed
        return {"ok": True, "sid": sid, "scene": scene, "query": hardened, "raw": raw}
    finally:
        conn.close()


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--sid", required=True)
    ap.add_argument("--op", required=True, choices=["suggest"])
    ap.add_argument("--scene", type=int, required=True)
    args = ap.parse_args()
    try:
        res = suggest(args.sid, scene=args.scene)
        print(json.dumps(res))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        sys.exit(1)
