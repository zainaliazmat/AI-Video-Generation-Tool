"""F-7 — honest rail pills + derived spec version, in one light spawn.

The rail's `zod ✓ / pydantic ✓` pills used to render green whenever the spec FETCH
succeeded — decorative, not bound to any check. This CLI binds them to reality:

  specVersion    — derived from the assemble patch history (1 + history rows).
  pydanticValid  — Spec.model_validate passes on the materialized spec.json
                   (the hand-mirrored contract; schema.ts is types-only, so this
                   is the only runtime guard).
  templatesValid — validate_spec against the live template catalog (per-template
                   zod-DERIVED JSON-Schema for templateProps + transition refs).
                   Honest pill label: "templates ✓", not "zod ✓" — nothing
                   zod-validates the whole spec anywhere.

Pure read; never mutates. Deliberately imports only cheap modules (schema +
validate + store) so the rail refresh stays fast.

Usage: python backend/session_meta.py --sid <id>
"""
from __future__ import annotations

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # backend/

import json
from session import store, job_ctx
from pipeline import projects as projects_mod
from pipeline import validate as validate_stage
from schema import Spec


def build_meta(sid: str) -> dict:
    conn = store.connect(job_ctx.SESSIONS_DB)
    try:
        if store.get_session(conn, sid) is None:
            raise KeyError(f"no session {sid!r}")
        version = store.spec_version(conn, sid)
    finally:
        conn.close()

    spec_path = projects_mod.project_spec_path(job_ctx.REPO_ROOT, sid)
    data = json.loads(spec_path.read_text(encoding="utf-8"))

    pydantic_valid, templates_valid = False, False
    error = None
    try:
        spec = Spec.model_validate(data)
        pydantic_valid = True
        validate_stage.validate_spec(spec, validate_stage.load_catalog(job_ctx.TEMPLATES_DIR))
        templates_valid = True
    except Exception as e:  # either layer failing -> its pill goes red, with the why
        error = str(e)

    return {"ok": True, "sid": sid, "specVersion": version,
            "pydanticValid": pydantic_valid, "templatesValid": templates_valid,
            "validationError": error}


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--sid", required=True)
    args = ap.parse_args()
    try:
        print(json.dumps(build_meta(args.sid)))
    except Exception as e:  # fail-loud: non-zero exit + error JSON on stdout
        print(json.dumps({"ok": False, "error": str(e)}))
        sys.exit(1)
