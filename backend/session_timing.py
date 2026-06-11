"""Studio v2 Timing CLI — read / fix_word (PRD §6.3).

Timing is deliberately NOT a gate — it is deterministic alignment (faster-whisper
word timestamps drive karaoke captions + per-scene durations at zero drift). The one
escape hatch is 'fix a word': correct a mis-transcribed caption TOKEN. The frames are
never shifted (timing stays pinned to the audio); only the displayed text changes.

  read     — the transcript tokens + the beat (line) spans, for the explainer + modal.
  fix_word — replace one token's text; re-derives captions (same frames, new text).

Usage:
  python backend/session_timing.py --sid <id> --op read
  python backend/session_timing.py --sid <id> --op fix_word --index <i> --text "kilometres"
"""
from __future__ import annotations

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # backend/

import json
from session import api, store, job_ctx


def _topic_for(sid: str) -> str:
    conn = store.connect(job_ctx.SESSIONS_DB)
    try:
        row = store.get_session(conn, sid)
        if row is None:
            raise KeyError(f"no session {sid!r}")
        return row["topic"]
    finally:
        conn.close()


def _serialize(sess) -> dict:
    words = sess.engine._load_output("timing") or []
    offsets = sess.engine._load_output("voice") or []
    return {
        "words": [{"index": i, "text": w.text, "startFrame": w.start_frame,
                   "endFrame": w.end_frame} for i, w in enumerate(words)],
        "lines": [{"index": o.index, "text": o.text, "start": o.start, "end": o.end}
                  for o in offsets],
    }


def read(sid: str) -> dict:
    ctx = job_ctx.build_ctx(topic=_topic_for(sid), sid=sid)
    sess = api.resume(job_ctx.SESSIONS_DB, ctx, session_id=sid)
    try:
        return {"ok": True, "sid": sid, **_serialize(sess)}
    finally:
        api.close(sess)


def fix_word(sid: str, *, index: int, text: str) -> dict:
    ctx = job_ctx.build_ctx(topic=_topic_for(sid), sid=sid)
    sess = api.resume(job_ctx.SESSIONS_DB, ctx, session_id=sid)
    try:
        api.edit(sess, "timing", {"op": "fix_word", "index": index, "text": text})
        return {"ok": True, "sid": sid, **_serialize(sess)}
    finally:
        api.close(sess)


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--sid", required=True)
    ap.add_argument("--op", required=True, choices=["read", "fix_word"])
    ap.add_argument("--index", type=int)
    ap.add_argument("--text")
    args = ap.parse_args()
    try:
        if args.op == "read":
            res = read(args.sid)
        else:
            if args.index is None or args.text is None:
                raise ValueError("--index and --text are required for fix_word")
            res = fix_word(args.sid, index=args.index, text=args.text)
        print(json.dumps(res))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        sys.exit(1)
