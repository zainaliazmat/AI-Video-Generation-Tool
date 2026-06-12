"""Apply one footage edit to a persisted session and re-materialize spec.json.

Three ops surface the footage gate (A.6.1 pick, A.6.2 re_query, A.6.3 upload):
- pick(scene, rank)   — offline/deterministic: binds the stored-pool clip the user saw.
- re_query(scene, query) — re-search Pexels, auto-bind the new pool's top hit (rank 1).
- upload(scene, file) — bind a user-supplied video/image file (source='uploaded').

Each: resume → api.edit (invalidate + re-derive assemble + materialize spec.json) →
return the post-edit scene state so the UI re-highlights / re-fetches from the response.
Fail-loud: bad sid → KeyError; non-footage / unknown rank / missing-or-bad upload → the
engine raises (surfaced as {"ok": false, "error": ...} + exit 1).

Usage:
  python backend/session_edit.py --sid <id> --op pick     --scene <n> --rank <r>
  python backend/session_edit.py --sid <id> --op re_query --scene <n> --query <str>
  python backend/session_edit.py --sid <id> --op upload   --scene <n> --file <path>
"""
from __future__ import annotations

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # backend/

import json
from session import api, store, job_ctx


def _apply(sid: str, op: dict) -> dict:
    """resume → apply one footage edit → return the post-edit scene state. Fail-loud
    (no internal except: a bad sid / op propagates to the caller)."""
    topic, target_length = _row_for(sid)
    ctx = job_ctx.build_ctx(topic=topic, sid=sid, target_length=target_length)
    sess = api.resume(job_ctx.SESSIONS_DB, ctx, session_id=sid)   # KeyError if no such session
    try:
        api.edit(sess, "footage", op)
        scene = op["scene_index"]
        prov = api.media_provenance(sess).get(scene)
        return {"ok": True, "sid": sid, "scene": scene,
                "selectedRank": (None if prov is None else prov["rank"]),
                "provenance": (None if prov is None else {
                    "source": prov["source"], "query": prov["query"], "rank": prov["rank"],
                    "pexelsId": prov["pexels_id"], "pexelsUrl": prov["pexels_url"]})}
    finally:
        api.close(sess)


def apply_pick(sid: str, *, scene: int, rank: int) -> dict:
    return _apply(sid, {"op": "pick", "scene_index": scene, "rank": rank})


def apply_requery(sid: str, *, scene: int, query: str) -> dict:
    return _apply(sid, {"op": "re_query", "scene_index": scene, "query": query})


def apply_upload(sid: str, *, scene: int, file: str) -> dict:
    return _apply(sid, {"op": "upload", "scene_index": scene, "file": file})


def _topic_for(sid: str) -> str:
    conn = store.connect(job_ctx.SESSIONS_DB)
    try:
        row = store.get_session(conn, sid)
        if row is None:
            raise KeyError(f"no session {sid!r}")
        return row["topic"]
    finally:
        conn.close()


def _row_for(sid: str) -> tuple[str, int]:
    """Return (topic, target_length) from the stored session row."""
    conn = store.connect(job_ctx.SESSIONS_DB)
    try:
        row = store.get_session(conn, sid)
        if row is None:
            raise KeyError(f"no session {sid!r}")
        return row["topic"], row["target_length"]
    finally:
        conn.close()


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--sid", required=True)
    ap.add_argument("--op", required=True, choices=["pick", "re_query", "upload"])
    ap.add_argument("--scene", type=int, required=True)
    ap.add_argument("--rank", type=int)   # pick
    ap.add_argument("--query")            # re_query
    ap.add_argument("--file")             # upload
    args = ap.parse_args()
    try:
        if args.op == "pick":
            if args.rank is None:
                raise ValueError("--rank is required for --op pick")
            res = apply_pick(args.sid, scene=args.scene, rank=args.rank)
        elif args.op == "re_query":
            if not args.query:
                raise ValueError("--query is required for --op re_query")
            res = apply_requery(args.sid, scene=args.scene, query=args.query)
        else:  # upload
            if not args.file:
                raise ValueError("--file is required for --op upload")
            res = apply_upload(args.sid, scene=args.scene, file=args.file)
        print(json.dumps(res))
    except Exception as e:  # fail-loud: non-zero exit + error JSON on stdout
        print(json.dumps({"ok": False, "error": str(e)}))
        sys.exit(1)
