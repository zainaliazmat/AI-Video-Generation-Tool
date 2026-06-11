"""Studio v2 Assemble gate CLI — read / chat / apply (PRD §6.5).

Chat-to-spec-patch: plain English -> a whitelist-validated spec.json patch -> apply
+ re-render. Frames are never edited; spec.json is the sole contract.

  read   — theme + per-scene summary + patch history + derived spec version.
  chat   — one LLM call proposing a patch for the user's message; validated locally,
           returned as {ops, reply, diff, valid}. One bounded retry on invalid output.
  apply  — apply a (client-confirmed) patch to the assemble output + re-materialize spec.
  revert — F-5 LIFO undo: revert the newest un-reverted applied patch by seq.

Usage:
  python backend/session_assemble.py --sid <id> --op read
  python backend/session_assemble.py --sid <id> --op chat --message "dark ember theme"
  python backend/session_assemble.py --sid <id> --op apply --patch-json '[{"op":"replace",...}]'
  python backend/session_assemble.py --sid <id> --op revert --seq 3
"""
from __future__ import annotations

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # backend/

import json
from session import api, store, job_ctx
from pipeline import spec_patch


def _topic_for(sid: str) -> str:
    conn = store.connect(job_ctx.SESSIONS_DB)
    try:
        row = store.get_session(conn, sid)
        if row is None:
            raise KeyError(f"no session {sid!r}")
        return row["topic"]
    finally:
        conn.close()


def _summary(spec) -> dict:
    data = spec.model_dump(by_alias=True)
    return {
        "theme": data.get("theme"),
        "scenes": [{"index": i, "template": s.get("template"),
                    "hasMedia": (s.get("media") is not None
                                 or (s.get("templateProps") or {}).get("media") is not None),
                    "transition": (s.get("transition") or {}).get("template")}
                   for i, s in enumerate(data.get("scenes", []))],
    }


def _history(conn, sid: str) -> dict:
    """F-5: the applied-patch event log + the derived spec version for the gate UI.
    Only the newest un-reverted patch is revertable (LIFO undo)."""
    rows = store.get_spec_patches(conn, sid)
    unreverted = [r["seq"] for r in rows if r["kind"] == "patch" and not r["reverted"]]
    return {
        "version": store.spec_version(conn, sid),
        "revertableSeq": unreverted[-1] if unreverted else None,
        "history": [{
            "seq": r["seq"], "kind": r["kind"], "diff": json.loads(r["diff_json"]),
            "reverted": bool(r["reverted"]), "revertsSeq": r["reverts_seq"],
            "createdAt": r["created_at"]} for r in rows],
    }


def read(sid: str) -> dict:
    ctx = job_ctx.build_ctx(topic=_topic_for(sid), sid=sid)
    sess = api.resume(job_ctx.SESSIONS_DB, ctx, session_id=sid)
    try:
        spec = sess.engine._load_output("assemble")
        if spec is None:
            raise RuntimeError("assemble stage has not completed")
        return {"ok": True, "sid": sid, **_summary(spec),
                **_history(sess.engine.conn, sid)}
    finally:
        api.close(sess)


def _llm_call(messages) -> str:
    """One DeepSeek (OpenAI-compatible) chat call returning the raw content."""
    from pipeline.config import get_env, require_env
    provider = get_env("LLM_PROVIDER", "deepseek")
    from openai import OpenAI
    if provider == "ollama":
        client = OpenAI(api_key="ollama", base_url=get_env("OLLAMA_BASE_URL", "http://localhost:11434") + "/v1")
        model = get_env("OLLAMA_MODEL", "llama3.1")
    else:
        client = OpenAI(api_key=require_env("DEEPSEEK_API_KEY"),
                        base_url=get_env("DEEPSEEK_BASE_URL", "https://api.deepseek.com"))
        model = get_env("DEEPSEEK_MODEL", "deepseek-v4-flash")
    resp = client.chat.completions.create(
        model=model, messages=messages, response_format={"type": "json_object"}, temperature=0.2)
    return resp.choices[0].message.content


def chat(sid: str, *, message: str, llm=None) -> dict:
    """Propose a patch for `message`. `llm(messages)->content` is injectable for tests."""
    ctx = job_ctx.build_ctx(topic=_topic_for(sid), sid=sid)
    sess = api.resume(job_ctx.SESSIONS_DB, ctx, session_id=sid)
    try:
        spec = sess.engine._load_output("assemble")
        if spec is None:
            raise RuntimeError("assemble stage has not completed")
        call = llm or _llm_call
        messages = spec_patch.build_chat_messages(message, spec)
        last_err = ""
        for attempt in range(2):                  # one bounded retry with the error in context
            content = call(messages)
            try:
                ops, reply = spec_patch.parse_chat_response(content)
                valid, err = spec_patch.validate_patch(ops) if ops else (True, "")
                if ops and not valid:
                    raise spec_patch.PatchError(err)
                diff = spec_patch.diff_lines(spec, ops) if ops else []
                return {"ok": True, "sid": sid, "ops": ops, "reply": reply,
                        "diff": diff, "valid": True}
            except spec_patch.PatchError as e:
                last_err = str(e)
                messages = messages + [
                    {"role": "assistant", "content": content},
                    {"role": "user", "content": f"That was invalid: {last_err}. "
                                                 "Return a corrected JSON object."}]
        return {"ok": True, "sid": sid, "ops": [], "reply": last_err or
                "couldn't compile that into a valid change", "diff": [], "valid": False}
    finally:
        api.close(sess)


def apply(sid: str, *, patch) -> dict:
    ctx = job_ctx.build_ctx(topic=_topic_for(sid), sid=sid)
    sess = api.resume(job_ctx.SESSIONS_DB, ctx, session_id=sid)
    try:
        spec_before = sess.engine._load_output("assemble")
        diff = spec_patch.diff_lines(spec_before, patch) if spec_before else []
        api.edit(sess, "assemble", {"patch": patch})
        return {"ok": True, "sid": sid, "applied": True, "diff": diff,
                **_history(sess.engine.conn, sid)}
    finally:
        api.close(sess)


def revert(sid: str, *, seq: int) -> dict:
    """F-5: undo the newest un-reverted patch (LIFO). The engine validates the seq
    and applies the inverse ops through the normal whitelist machinery."""
    ctx = job_ctx.build_ctx(topic=_topic_for(sid), sid=sid)
    sess = api.resume(job_ctx.SESSIONS_DB, ctx, session_id=sid)
    try:
        api.edit(sess, "assemble", {"revert": seq})
        return {"ok": True, "sid": sid, "reverted": seq,
                **_history(sess.engine.conn, sid)}
    finally:
        api.close(sess)


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--sid", required=True)
    ap.add_argument("--op", required=True, choices=["read", "chat", "apply", "revert"])
    ap.add_argument("--message")
    ap.add_argument("--patch-json")
    ap.add_argument("--seq", type=int)
    args = ap.parse_args()
    try:
        if args.op == "read":
            res = read(args.sid)
        elif args.op == "chat":
            if not args.message:
                raise ValueError("--message is required for chat")
            res = chat(args.sid, message=args.message)
        elif args.op == "revert":
            if args.seq is None:
                raise ValueError("--seq is required for revert")
            res = revert(args.sid, seq=args.seq)
        else:  # apply
            if not args.patch_json:
                raise ValueError("--patch-json is required for apply")
            res = apply(args.sid, patch=json.loads(args.patch_json))
        print(json.dumps(res))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        sys.exit(1)
