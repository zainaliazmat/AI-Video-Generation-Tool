"""Generate templates/manifest.schema.json from the Pydantic Manifest model.

The regenerate-and-diff pattern gen-previews' --check already uses: Pydantic is the
source of truth; the committed JSON Schema is the node-side installer's
validator; tests/test_manifest_schema.py is the drift check.

Usage:
    python backend/gen_manifest_schema.py           # (re)write the file
    python backend/gen_manifest_schema.py --check   # exit 1 on drift
"""
import json
import sys
from pathlib import Path

from manifest import Manifest

SCHEMA_PATH = Path(__file__).resolve().parents[1] / "templates" / "manifest.schema.json"


def render_schema() -> str:
    return json.dumps(Manifest.model_json_schema(), indent=2, sort_keys=True) + "\n"


def main() -> int:
    text = render_schema()
    if "--check" in sys.argv[1:]:
        if not SCHEMA_PATH.exists():
            print(f"[gen-manifest-schema] MISSING: {SCHEMA_PATH} — "
                  f"generate with: python backend/gen_manifest_schema.py", file=sys.stderr)
            return 1
        if SCHEMA_PATH.read_text(encoding="utf-8") != text:
            print(f"[gen-manifest-schema] DRIFT: {SCHEMA_PATH} is stale — "
                  f"regenerate with: python backend/gen_manifest_schema.py", file=sys.stderr)
            return 1
        print("[gen-manifest-schema] up to date")
        return 0
    SCHEMA_PATH.write_text(text, encoding="utf-8")
    print(f"[gen-manifest-schema] wrote {SCHEMA_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
