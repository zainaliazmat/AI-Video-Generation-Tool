"""A.6.1 — read-only session state for the preview footage gate.

Resolves the persisted session's per-scene candidate pool + provenance. Pure read:
opens the DB, reads the materialized spec.json for the scene list, joins the footage
candidate pool + media provenance. Prints one JSON line; never mutates.

Usage: python backend/session_state.py --sid <id>
"""
from __future__ import annotations

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # backend/

import json
from session import store, job_ctx


def build_state(sid: str) -> dict:
    conn = store.connect(job_ctx.SESSIONS_DB)
    try:
        if store.get_session(conn, sid) is None:
            raise KeyError(f"no session {sid!r}")
        spec = json.loads(pathlib.Path(job_ctx.SPEC_OUT).read_text(encoding="utf-8"))
        prov = store.get_media_provenance(conn, sid)
        scenes = []
        for i, sc in enumerate(spec.get("scenes", [])):
            media = (sc.get("templateProps") or {}).get("media")
            needs_footage = media is not None
            candidates = []
            if needs_footage:
                for r in store.get_footage_candidates(conn, sid, scene_index=i):
                    candidates.append({
                        "rank": r["rank"], "thumbUrl": r["thumb_url"],
                        "durationFrames": r["duration_frames"], "selected": bool(r["selected"])})
            p = prov.get(i)
            scenes.append({
                "index": i, "template": sc.get("template"), "needsFootage": needs_footage,
                "candidates": candidates,
                "provenance": (None if p is None else {
                    "source": p["source"], "query": p["query"], "rank": p["rank"],
                    "pexelsId": p["pexels_id"], "pexelsUrl": p["pexels_url"]})})
        return {"sid": sid, "scenes": scenes}
    finally:
        conn.close()


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--sid", required=True)
    args = ap.parse_args()
    try:
        print(json.dumps(build_state(args.sid)))
    except Exception as e:  # fail-loud: non-zero exit + error JSON on stdout
        print(json.dumps({"ok": False, "error": str(e)}))
        sys.exit(1)
