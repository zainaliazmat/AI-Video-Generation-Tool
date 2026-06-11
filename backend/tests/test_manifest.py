"""Tests for the template manifest contract (backend/manifest.py).

The manifest is the language-neutral contract read by BOTH the Python backend
(to know the catalog / validate specs) and the renderer (to build its registry).
Python validates manifest.json files; the inputSchema is JSON Schema generated
from each template's zod schema.
"""
import pathlib

import pytest
from pydantic import ValidationError

from manifest import Manifest
from pipeline.validate import load_catalog

_TEMPLATES_DIR = pathlib.Path(__file__).resolve().parents[2] / "templates"


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


def test_renders_own_text_defaults_false_and_parses():
    # Absent → False (footage/transition templates let the global caption show).
    assert Manifest.model_validate(_valid()).rendersOwnText is False
    flagged = {**_valid(), "rendersOwnText": True}
    assert Manifest.model_validate(flagged).rendersOwnText is True


def test_core_full_text_templates_declare_rendersOwnText():
    # The full-text hero cards own their on-screen text, so the karaoke caption is
    # suppressed over them; footage/overlay templates keep captions.
    catalog = load_catalog(_TEMPLATES_DIR)
    # enumeration is a scene-slot card that renders its OWN labels, so it belongs on
    # the own-text side (caption suppressed) despite kind=="scene" (design §3 watch-item).
    for hero in ("hook", "stat", "outro", "enumeration"):
        assert catalog[hero].rendersOwnText is True, f"{hero} must set rendersOwnText"
    for footage in ("scene", "overlay"):
        assert catalog[footage].rendersOwnText is False, f"{footage} must not own text"


def test_enumeration_manifest_loads_with_capability():
    # The enumeration plugin declares the routing capability the recipe reads.
    catalog = load_catalog(_TEMPLATES_DIR)
    m = catalog["enumeration"]
    assert m.kind == "scene"
    assert m.rendersOwnText is True
    assert m.consumes == "enumeration"
