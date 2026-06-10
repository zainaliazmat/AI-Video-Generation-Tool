"""A.6.1 — apply one footage edit to a persisted session and re-materialize spec.json.

A.6.1 accepts only op="pick" (offline/deterministic: binds the stored-pool clip the
user was shown). resume → api.edit (invalidate + re-derive assemble + materialize
spec.json) → return the post-edit scene state so the UI re-highlights from the
response. Fail-loud: bad sid → KeyError; non-footage / unknown rank → the engine raises.

Usage: python backend/session_edit.py --sid <id> --op pick --scene <n> --rank <r>
"""
from __future__ import annotations

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # backend/

import json
from session import api, store, job_ctx


def apply_pick(sid: str, *, scene: int, rank: int) -> dict:
    ctx = job_ctx.build_ctx(topic=_topic_for(sid))
    sess = api.resume(job_ctx.SESSIONS_DB, ctx, session_id=sid)   # KeyError if no such session
    try:
        api.edit(sess, "footage", {"op": "pick", "scene_index": scene, "rank": rank})
        prov = api.media_provenance(sess).get(scene)
        return {"ok": True, "sid": sid, "scene": scene, "selectedRank": rank,
                "provenance": (None if prov is None else {
                    "source": prov["source"], "query": prov["query"], "rank": prov["rank"],
                    "pexelsId": prov["pexels_id"], "pexelsUrl": prov["pexels_url"]})}
    finally:
        api.close(sess)


def _topic_for(sid: str) -> str:
    conn = store.connect(job_ctx.SESSIONS_DB)
    try:
        row = store.get_session(conn, sid)
        if row is None:
            raise KeyError(f"no session {sid!r}")
        return row["topic"]
    finally:
        conn.close()


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--sid", required=True)
    ap.add_argument("--op", required=True, choices=["pick"])  # re_query/upload arrive in A.6.2/A.6.3
    ap.add_argument("--scene", type=int, required=True)
    ap.add_argument("--rank", type=int, required=True)
    args = ap.parse_args()
    try:
        print(json.dumps(apply_pick(args.sid, scene=args.scene, rank=args.rank)))
    except Exception as e:  # fail-loud: non-zero exit + error JSON on stdout
        print(json.dumps({"ok": False, "error": str(e)}))
        sys.exit(1)
