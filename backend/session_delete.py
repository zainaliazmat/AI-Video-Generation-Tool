"""Delete a project (= session): purge the SQLite session + remove projects/<sid>/
and the namespaced voiceover from both asset roots. Footage is shared/content-
addressed and left in place. Idempotent. Spawned by DELETE /api/projects/[id].

Usage: python backend/session_delete.py --sid <id>
"""
from __future__ import annotations

import sys
import pathlib
import shutil

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # backend/

import json
from pipeline import projects as projects_mod
from session import store, job_ctx


def delete(sid: str) -> dict:
    repo = job_ctx.REPO_ROOT
    # 1) SQLite session rows
    conn = store.connect(job_ctx.SESSIONS_DB)
    try:
        store.delete_session(conn, sid)
    finally:
        conn.close()
    # 2) project folder
    shutil.rmtree(projects_mod.project_dir(repo, sid), ignore_errors=True)
    # 3) namespaced voiceover in both asset roots (shared footage stays)
    voiceover = projects_mod.voiceover_name(sid)
    for root in ("remotion/public/assets", "preview/public/assets"):
        p = repo / root / voiceover
        try:
            p.unlink()
        except FileNotFoundError:
            pass
    return {"ok": True, "sid": sid}


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--sid", required=True)
    args = ap.parse_args()
    try:
        print(json.dumps(delete(args.sid)))
    except Exception as e:  # fail-loud
        print(json.dumps({"ok": False, "error": str(e)}))
        sys.exit(1)
