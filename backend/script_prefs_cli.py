"""Global script-preferences CLI — is_initialized / get / save.

The honest sibling of session_script.py's style-memory manager: where style memory
is LEARNED from edits, this is the operator's DECLARED channel voice (tone, audience,
hook style, personality, niche…), collected once and reused on every generation.
Reads/writes the global doc at job_ctx.STYLE_PREFS_PATH. JSON on stdout; non-zero
exit + error JSON on failure (same contract the Next.js spawn layer expects).

Usage:
  python backend/script_prefs_cli.py --op is_initialized
  python backend/script_prefs_cli.py --op get
  python backend/script_prefs_cli.py --op save --prefs-json '{"tone":"energetic"}'
"""
from __future__ import annotations

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # backend/

import json
from session import job_ctx
from pipeline import script_prefs


def is_initialized() -> dict:
    return {"ok": True, "initialized": script_prefs.is_initialized(job_ctx.STYLE_PREFS_PATH)}


def get() -> dict:
    return {"ok": True,
            "initialized": script_prefs.is_initialized(job_ctx.STYLE_PREFS_PATH),
            "prefs": script_prefs.load(job_ctx.STYLE_PREFS_PATH)}


def save(prefs: dict) -> dict:
    if not isinstance(prefs, dict):
        raise ValueError("prefs must be a JSON object")
    # Coerce to the known shape (drops unknown keys, backfills missing) so a bad
    # client payload can never write a malformed doc.
    normalized = script_prefs.merge(script_prefs.EMPTY, prefs)
    script_prefs.save(job_ctx.STYLE_PREFS_PATH, normalized)
    return {"ok": True,
            "initialized": script_prefs.is_initialized(job_ctx.STYLE_PREFS_PATH),
            "prefs": normalized}


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--op", required=True, choices=["is_initialized", "get", "save"])
    ap.add_argument("--prefs-json")
    args = ap.parse_args()
    try:
        if args.op == "is_initialized":
            res = is_initialized()
        elif args.op == "get":
            res = get()
        else:  # save
            if not args.prefs_json:
                raise ValueError("--prefs-json is required for save")
            res = save(json.loads(args.prefs_json))
        print(json.dumps(res))
    except Exception as e:  # fail-loud: non-zero exit + error JSON on stdout
        print(json.dumps({"ok": False, "error": str(e)}))
        sys.exit(1)
