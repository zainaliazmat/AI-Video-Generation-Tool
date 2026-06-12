"""The third validator must never drift (§4.2): templates/manifest.schema.json
is GENERATED from the Pydantic Manifest (the source of truth) and committed.
This test IS the CI diff check — it fails when the committed file is stale."""
import json

from gen_manifest_schema import SCHEMA_PATH, render_schema


def test_committed_schema_matches_model():
    assert SCHEMA_PATH.exists(), (
        f"{SCHEMA_PATH} missing — generate with: python backend/gen_manifest_schema.py"
    )
    assert SCHEMA_PATH.read_text(encoding="utf-8") == render_schema(), (
        "templates/manifest.schema.json is stale — regenerate with: "
        "python backend/gen_manifest_schema.py"
    )


def test_schema_carries_strict_envelope():
    # extra="forbid" must surface as additionalProperties:false so the
    # node-side installer inherits the same strictness (§15.13).
    schema = json.loads(render_schema())
    assert schema["additionalProperties"] is False
