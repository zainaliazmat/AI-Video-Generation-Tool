"""Studio v2 Script gate CLI — read / edit_beat / drop_beat / regenerate / approve.

The highest-value gate (PRD §6.1): a read / approve / regenerate-with-feedback loop
over the persisted script stage, with verify-on-edit (flag amber, never auto-drop)
and an honestly-named style memory that seeds future generations.

  read       — current beats + sources + verify state + fact-floor.
  edit_beat  — change a beat's text/data; re-runs verify FOR THAT BEAT (flag), then
               re-derives the whole downstream pipeline + spec.json.
  drop_beat  — remove a beat (re-derives downstream).
  regenerate — re-run generation with feedback + style memory injected as an additive
               USER block (frozen SYSTEM_PROMPT untouched); produces a new version.
  approve    — append accepted edits / rejection guidance to style_memory.json.

Usage:
  python backend/session_script.py --sid <id> --op read
  python backend/session_script.py --sid <id> --op edit_beat --index <i> --text "..."
  python backend/session_script.py --sid <id> --op edit_beat --index <i> --clear-data
  python backend/session_script.py --sid <id> --op drop_beat --index <i>
  python backend/session_script.py --sid <id> --op regenerate --feedback "punchier hook"
  python backend/session_script.py --sid <id> --op approve --edits-json '[{"before":"..","after":".."}]'
"""
from __future__ import annotations

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # backend/

import json
from session import api, store, job_ctx
from pipeline import style_memory


def _topic_for(sid: str) -> str:
    conn = store.connect(job_ctx.SESSIONS_DB)
    try:
        row = store.get_session(conn, sid)
        if row is None:
            raise KeyError(f"no session {sid!r}")
        return row["topic"]
    finally:
        conn.close()


def _floor(beats) -> dict:
    """Two-tier fact floor (PRD §6.1): supported = beats carrying a grounded source.
    0 supported = hard-fail tier; 1 = warn; else ok."""
    supported = sum(1 for b in beats if b.source)
    level = "hard_fail" if supported == 0 else ("warn" if supported == 1 else "ok")
    return {"supported": supported, "total": len(beats), "level": level}


def _serialize(bundle) -> dict:
    s = bundle["script"]
    flags = {f["index"]: f for f in (s.beat_flags or [])}
    beats = []
    for i, b in enumerate(s.beats):
        beats.append({
            "index": i, "text": b.text, "data": b.data, "keywords": b.keywords,
            "source": b.source,
            "flag": (flags.get(i, {}) or {}).get("status"),
            "flagReason": (flags.get(i, {}) or {}).get("reason"),
        })
    return {
        "title": s.title,
        "beats": beats,
        "sources": [{"url": x.url, "title": x.title} for x in (s.sources or [])],
        "verifyReport": s.verify_report or [],
        "factFloor": _floor(s.beats),
    }


def _build_verify_fns():
    """Best-effort live verify-on-edit fns. Returns (verify_fn, retrieve_fn) or
    (None, None) when keys/providers are unavailable — the edit still applies, the
    beat just isn't re-flagged (UI shows 'not re-verified')."""
    try:
        from pipeline import script as script_stage
        from pipeline import retrieval
        from pipeline.config import get_env
        if not get_env("DEEPSEEK_API_KEY") and get_env("LLM_PROVIDER", "deepseek") == "deepseek":
            return None, None
        return script_stage._build_verify_fn(), retrieval.retrieve
    except Exception:
        return None, None


def read(sid: str) -> dict:
    ctx = job_ctx.build_ctx(topic=_topic_for(sid), sid=sid)
    sess = api.resume(job_ctx.SESSIONS_DB, ctx, session_id=sid)
    try:
        bundle = sess.engine._load_output("script")
        if bundle is None:
            raise RuntimeError("script stage has not completed")
        return {"ok": True, "sid": sid, **_serialize(bundle)}
    finally:
        api.close(sess)


def edit_beat(sid: str, *, index: int, text=None, data=None, clear_data=False) -> dict:
    ctx = job_ctx.build_ctx(topic=_topic_for(sid), sid=sid)
    sess = api.resume(job_ctx.SESSIONS_DB, ctx, session_id=sid)
    try:
        vfn, rfn = _build_verify_fns()
        op = {"op": "edit_beat", "index": index, "verify_fn": vfn, "retrieve_fn": rfn}
        if text is not None:
            op["text"] = text
        if clear_data:
            op["data"] = None
        elif data is not None:
            op["data"] = data
        api.edit(sess, "script", op)
        return {"ok": True, "sid": sid, **_serialize(sess.engine._load_output("script"))}
    finally:
        api.close(sess)


def drop_beat(sid: str, *, index: int) -> dict:
    ctx = job_ctx.build_ctx(topic=_topic_for(sid), sid=sid)
    sess = api.resume(job_ctx.SESSIONS_DB, ctx, session_id=sid)
    try:
        api.edit(sess, "script", {"op": "drop_beat", "index": index})
        return {"ok": True, "sid": sid, **_serialize(sess.engine._load_output("script"))}
    finally:
        api.close(sess)


def regenerate(sid: str, *, feedback: str = "") -> dict:
    mem = style_memory.load(job_ctx.STYLE_MEMORY_PATH)
    block_parts = []
    if feedback.strip():
        block_parts.append(f"OPERATOR FEEDBACK for this regeneration: {feedback.strip()}")
    mem_block = style_memory.to_prompt_block(mem)
    if mem_block:
        block_parts.append(mem_block)
    extra = "\n\n".join(block_parts)
    ctx = job_ctx.build_ctx(topic=_topic_for(sid), sid=sid, extra_user_block=extra)
    sess = api.resume(job_ctx.SESSIONS_DB, ctx, session_id=sid)
    try:
        api.regenerate(sess, "script")
        return {"ok": True, "sid": sid, "regenerated": True,
                **_serialize(sess.engine._load_output("script"))}
    finally:
        api.close(sess)


def approve(sid: str, *, edits=None, guidance=None) -> dict:
    """Lock the script and fold accepted edits / rejection guidance into style memory
    (the honest cross-video improvement seam)."""
    mem = style_memory.load(job_ctx.STYLE_MEMORY_PATH)
    for e in (edits or []):
        style_memory.record_edit(mem, before=e.get("before", ""), after=e.get("after", ""))
    for g in (guidance or []):
        style_memory.record_guidance(mem, g)
    style_memory.save(job_ctx.STYLE_MEMORY_PATH, mem)
    return {"ok": True, "sid": sid, "approved": True,
            "styleMemory": {"examples": len(mem.get("examples", [])),
                            "guidance": len(mem.get("guidance", []))}}


# ---- F-6: style-memory manager (the PRD's "caps + manager UI (pin/delete)") ----
# Memory is repo-level (cross-video by design); sid rides along for response symmetry.

def _memory_doc(mem) -> dict:
    return {"styleMemory": {
        "examples": [{"index": i, "before": e["before"], "after": e["after"],
                      "pinned": bool(e.get("pinned"))}
                     for i, e in enumerate(mem.get("examples", []))],
        "guidance": [{"index": i, "text": g["text"], "pinned": bool(g.get("pinned"))}
                     for i, g in enumerate(mem.get("guidance", []))],
        "caps": {"examples": style_memory.MAX_EXAMPLES,
                 "guidance": style_memory.MAX_GUIDANCE}}}


def _check_memory_target(mem, *, kind: str, index: int) -> None:
    """Fail loud: the underlying pin/delete helpers silently no-op on a bad kind or
    out-of-range index — that must not leak through the CLI as a quiet success."""
    if kind not in ("example", "guidance"):
        raise ValueError(f"kind must be 'example' or 'guidance', got {kind!r}")
    items = mem.get("examples" if kind == "example" else "guidance", [])
    if not (0 <= index < len(items)):
        raise IndexError(f"no {kind} at index {index} (have {len(items)})")


def style_memory_read(sid: str) -> dict:
    mem = style_memory.load(job_ctx.STYLE_MEMORY_PATH)
    return {"ok": True, "sid": sid, **_memory_doc(mem)}


def style_memory_pin(sid: str, *, kind: str, index: int, value: bool = True) -> dict:
    mem = style_memory.load(job_ctx.STYLE_MEMORY_PATH)
    _check_memory_target(mem, kind=kind, index=index)
    style_memory.pin(mem, kind=kind, index=index, value=value)
    style_memory.save(job_ctx.STYLE_MEMORY_PATH, mem)
    return {"ok": True, "sid": sid, **_memory_doc(mem)}


def style_memory_delete(sid: str, *, kind: str, index: int) -> dict:
    mem = style_memory.load(job_ctx.STYLE_MEMORY_PATH)
    _check_memory_target(mem, kind=kind, index=index)
    style_memory.delete(mem, kind=kind, index=index)
    style_memory.save(job_ctx.STYLE_MEMORY_PATH, mem)
    return {"ok": True, "sid": sid, **_memory_doc(mem)}


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--sid", required=True)
    ap.add_argument("--op", required=True,
                    choices=["read", "edit_beat", "drop_beat", "regenerate", "approve",
                             "style_memory_read", "style_memory_pin", "style_memory_delete"])
    ap.add_argument("--index", type=int)
    ap.add_argument("--text")
    ap.add_argument("--data-json")
    ap.add_argument("--clear-data", action="store_true")
    ap.add_argument("--feedback", default="")
    ap.add_argument("--edits-json")
    ap.add_argument("--guidance-json")
    ap.add_argument("--kind")                      # style_memory_*: example | guidance
    ap.add_argument("--value", default="true")     # style_memory_pin: true | false
    args = ap.parse_args()
    try:
        if args.op == "read":
            res = read(args.sid)
        elif args.op == "style_memory_read":
            res = style_memory_read(args.sid)
        elif args.op in ("style_memory_pin", "style_memory_delete"):
            if args.kind is None or args.index is None:
                raise ValueError(f"--kind and --index are required for {args.op}")
            if args.op == "style_memory_pin":
                res = style_memory_pin(args.sid, kind=args.kind, index=args.index,
                                       value=args.value.lower() != "false")
            else:
                res = style_memory_delete(args.sid, kind=args.kind, index=args.index)
        elif args.op == "edit_beat":
            if args.index is None:
                raise ValueError("--index is required for edit_beat")
            data = json.loads(args.data_json) if args.data_json else None
            res = edit_beat(args.sid, index=args.index, text=args.text,
                            data=data, clear_data=args.clear_data)
        elif args.op == "drop_beat":
            if args.index is None:
                raise ValueError("--index is required for drop_beat")
            res = drop_beat(args.sid, index=args.index)
        elif args.op == "regenerate":
            res = regenerate(args.sid, feedback=args.feedback)
        else:  # approve
            edits = json.loads(args.edits_json) if args.edits_json else []
            guidance = json.loads(args.guidance_json) if args.guidance_json else []
            res = approve(args.sid, edits=edits, guidance=guidance)
        print(json.dumps(res))
    except Exception as e:  # fail-loud: non-zero exit + error JSON on stdout
        print(json.dumps({"ok": False, "error": str(e)}))
        sys.exit(1)
