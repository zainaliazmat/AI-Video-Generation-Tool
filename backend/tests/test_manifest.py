"""Tests for the template manifest contract (backend/manifest.py).

The manifest is the language-neutral contract read by BOTH the Python backend
(to know the catalog / validate specs) and the renderer (to build its registry).
Python validates manifest.json files; the inputSchema is JSON Schema generated
from each template's zod schema.
"""
import pytest
from pydantic import ValidationError

from manifest import Manifest


def _valid() -> dict:
    # The stat-callout example from the phase-2 build prompt.
    return {
        "id": "stat-callout",
        "name": "Stat Callout",
        "version": "1.0.0",
        "author": "you",
        "apiVersion": "1",
        "kind": "stat",
        "inputSchema": {
            "type": "object",
            "properties": {
                "value": {"type": "string"},
                "label": {"type": "string"},
                "icon": {"type": "string"},
            },
            "required": ["value", "label"],
        },
        "sampleProps": {"value": "90%", "label": "of the ocean is unexplored", "icon": "wave"},
        "durationFrames": {"min": 45, "max": 120},
    }


def test_valid_manifest_parses():
    m = Manifest.model_validate(_valid())
    assert m.id == "stat-callout"
    assert m.kind == "stat"
    assert m.durationFrames.min == 45
    assert m.durationFrames.max == 120
    assert m.inputSchema["required"] == ["value", "label"]


def test_unknown_kind_rejected():
    bad = _valid()
    bad["kind"] = "banana"          # not one of the declared slots
    with pytest.raises(ValidationError):
        Manifest.model_validate(bad)


def test_missing_required_field_rejected():
    bad = _valid()
    del bad["id"]
    with pytest.raises(ValidationError):
        Manifest.model_validate(bad)


@pytest.mark.parametrize(
    "kind",
    ["hook", "scene", "stat", "lower-third", "transition", "overlay", "outro"],
)
def test_all_declared_slots_accepted(kind):
    ok = _valid()
    ok["kind"] = kind
    assert Manifest.model_validate(ok).kind == kind
