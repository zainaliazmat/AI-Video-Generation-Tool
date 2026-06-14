"""Apply one footage edit to a persisted session and re-materialize spec.json.

Ops surface the footage gate (A.6.1 pick, A.6.2 re_query, A.6.3 upload):
- pick(scene, rank)            — offline/deterministic: binds the stored-pool clip the user saw.
- re_query(scene, query)       — re-search Pexels, auto-bind the new pool's top hit (rank 1).
- upload(scene, file)          — bind a user-supplied video/image file (source='uploaded').
- pick_template(scene, template) — override the scene template (T6).

v3 gate extensions:
  --target footage|background  — footage (default) or background override (hero scenes only)
  --broaden                    — re_query: use the topic title as the query (whiff-fallback)
  --template                   — pick_template: the template id to apply

Each: resume → api.edit (invalidate + re-derive assemble + materialize spec.json) →
return the post-edit scene state so the UI re-highlights / re-fetches from the response.
Fail-loud: bad sid → KeyError; non-footage / unknown rank / missing-or-bad upload → the
engine raises (surfaced as {"ok": false, "error": ...} + exit 1).

Usage:
  python backend/session_edit.py --sid <id> --op pick     --scene <n> --rank <r>
  python backend/session_edit.py --sid <id> --op re_query --scene <n> --query <str>
  python backend/session_edit.py --sid <id> --op upload   --scene <n> --file <path>
  python backend/session_edit.py --sid <id> --op pick     --scene <n> --rank <r> --target background
  python backend/session_edit.py --sid <id> --op re_query --scene <n> --broaden --target background
  python backend/session_edit.py --sid <id> --op pick_template --scene <n> --template <id>
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
        if op.get("target") == "background":
            # Background ops write to background_overrides, not media_provenance.
            # Read back the override row so the response is honest (not null).
            conn = store.connect(job_ctx.SESSIONS_DB)
            try:
                bov = store.get_background_overrides(conn, sid).get(scene)
            finally:
                conn.close()
            return {"ok": True, "sid": sid, "scene": scene,
                    "selectedRank": (None if bov is None else bov["picked_rank"]),
                    "provenance": (None if bov is None else {
                        "source": bov["source"],
                        "query": (bov.get("value") or {}).get("query"),
                        "rank": bov["picked_rank"],
                        "pexelsId": (bov.get("value") or {}).get("pexels_id"),
                        "pexelsUrl": (bov.get("value") or {}).get("pexels_url")})}
        prov = api.media_provenance(sess).get(scene)
        return {"ok": True, "sid": sid, "scene": scene,
                "selectedRank": (None if prov is None else prov["rank"]),
                "provenance": (None if prov is None else {
                    "source": prov["source"], "query": prov["query"], "rank": prov["rank"],
                    "pexelsId": prov["pexels_id"], "pexelsUrl": prov["pexels_url"]})}
    finally:
        api.close(sess)


def apply_pick(sid: str, *, scene: int, rank: int, target: str = "footage") -> dict:
    return _apply(sid, {"op": "pick", "scene_index": scene, "rank": rank, "target": target})


def apply_requery(sid: str, *, scene: int, query: str = "", target: str = "footage",
                  broaden: bool = False) -> dict:
    op: dict = {"op": "re_query", "scene_index": scene, "target": target}
    if broaden:
        op["broaden"] = True
    else:
        op["query"] = query
    return _apply(sid, op)


def apply_upload(sid: str, *, scene: int, file: str, target: str = "footage") -> dict:
    return _apply(sid, {"op": "upload", "scene_index": scene, "file": file, "target": target})


def apply_pick_template(sid: str, *, scene: int, template: str) -> dict:
    return _apply(sid, {"op": "pick_template", "scene_index": scene, "template": template})


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


def build_parser():
    """Return the ArgumentParser for session_edit.  Extracted so tests can import
    and exercise it directly rather than rebuilding it inline (Fix 3)."""
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--sid", required=True)
    ap.add_argument("--op", required=True, choices=["pick", "re_query", "upload", "pick_template"])
    ap.add_argument("--scene", type=int, required=True)
    ap.add_argument("--rank", type=int)          # pick / pick (background)
    ap.add_argument("--query")                   # re_query
    ap.add_argument("--file")                    # upload
    ap.add_argument("--target", default="footage",
                    choices=["footage", "background"])  # v3: background override target
    ap.add_argument("--broaden", action="store_true")   # v3: re_query → topic title
    ap.add_argument("--template")                        # v3: pick_template
    return ap


def main(argv=None):
    """CLI entry-point.  Returns 0 on success, 1 on error (prints JSON either way).
    Pass argv explicitly in tests; defaults to sys.argv[1:] when called as __main__."""
    args = build_parser().parse_args(argv)
    try:
        if args.op == "pick":
            if args.rank is None:
                raise ValueError("--rank is required for --op pick")
            res = apply_pick(args.sid, scene=args.scene, rank=args.rank, target=args.target)
        elif args.op == "re_query":
            if not args.broaden and not args.query:
                raise ValueError("--query is required for --op re_query (or use --broaden)")
            res = apply_requery(args.sid, scene=args.scene, query=args.query or "",
                                target=args.target, broaden=args.broaden)
        elif args.op == "upload":
            if not args.file:
                raise ValueError("--file is required for --op upload")
            res = apply_upload(args.sid, scene=args.scene, file=args.file, target=args.target)
        else:  # pick_template
            if not args.template:
                raise ValueError("--template is required for --op pick_template")
            res = apply_pick_template(args.sid, scene=args.scene, template=args.template)
        print(json.dumps(res))
        return 0
    except Exception as e:  # fail-loud: non-zero exit + error JSON on stdout
        print(json.dumps({"ok": False, "error": str(e)}))
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
