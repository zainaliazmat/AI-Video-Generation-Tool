"""Step 6.3 — spec validation: per-template inputSchema + slot/kind rules.

This is the fail-fast backstop behind the renderer's type-level discrimination:
a bad prop or a template used in the wrong slot must fail loudly BEFORE render.
`validate_spec` is pure given an injected catalog (id -> Manifest).
"""
import pytest

from manifest import Manifest
from schema import Spec, Meta, Audio, Scene, Caption, Theme, Transition, Layer
from pipeline.validate import validate_spec, load_catalog


def _man(id, kind, input_schema=None, required=None):
    return Manifest(
        id=id, name=id, version="1.0.0", author="t", apiVersion="1", kind=kind,
        inputSchema=input_schema or {
            "type": "object", "additionalProperties": False,
            "properties": {"title": {"type": "string"}}, "required": required or [],
        },
        sampleProps={}, durationFrames={"min": 1, "max": 100},
    )


def _catalog(*mans):
    return {m.id: m for m in mans}


def _spec(scenes, *, layers=None):
    return Spec(
        meta=Meta(title="T", durationInFrames=100),
        audio=Audio(voiceover="assets/v.wav"),
        scenes=scenes, captions=[Caption(text="a", startFrame=0, endFrame=5)],
        theme=Theme(), layers=layers or [],
    )


HOOK = _man("hook", "hook", required=["title"])
SCENE = _man("scene", "scene", input_schema={
    "type": "object", "additionalProperties": False,
    "properties": {"media": {"type": "object"}}, "required": ["media"]})
STAT = _man("stat", "stat", input_schema={
    "type": "object", "additionalProperties": False,
    "properties": {"value": {"type": "string"}, "label": {"type": "string"}}, "required": ["value", "label"]})
FADE = _man("fade", "transition", input_schema={"type": "object", "properties": {}})
OVERLAY = _man("overlay", "overlay", input_schema={
    "type": "object", "additionalProperties": False, "properties": {"text": {"type": "string"}}, "required": ["text"]})
CATALOG = _catalog(HOOK, SCENE, STAT, FADE, OVERLAY)


def test_valid_spec_passes():
    spec = _spec([
        Scene(id="s0", startFrame=0, durationInFrames=50, template="hook", templateProps={"title": "Hi"}),
        Scene(id="s1", startFrame=50, durationInFrames=50, template="stat", templateProps={"value": "9", "label": "x"}),
    ])
    validate_spec(spec, CATALOG)  # no raise


def test_unknown_template_id_raises():
    spec = _spec([Scene(id="s0", startFrame=0, durationInFrames=50, template="nope", templateProps={})])
    with pytest.raises(ValueError, match="nope"):
        validate_spec(spec, CATALOG)


def test_scene_missing_template_raises():
    spec = _spec([Scene(id="s0", startFrame=0, durationInFrames=50, template=None)])
    with pytest.raises(ValueError):
        validate_spec(spec, CATALOG)


def test_transition_kind_in_scene_slot_raises():
    spec = _spec([Scene(id="s0", startFrame=0, durationInFrames=50, template="fade", templateProps={})])
    with pytest.raises(ValueError, match="slot|kind|transition"):
        validate_spec(spec, CATALOG)


def test_scene_transition_must_reference_transition_kind():
    spec = _spec([
        Scene(id="s0", startFrame=0, durationInFrames=50, template="hook", templateProps={"title": "Hi"},
              transition=Transition(template="hook", durationInFrames=10)),  # hook is not a transition
        Scene(id="s1", startFrame=50, durationInFrames=50, template="hook", templateProps={"title": "Bye"}),
    ])
    with pytest.raises(ValueError, match="transition|slot|kind"):
        validate_spec(spec, CATALOG)


def test_layer_must_reference_overlay_kind():
    spec = _spec(
        [Scene(id="s0", startFrame=0, durationInFrames=50, template="hook", templateProps={"title": "Hi"})],
        layers=[Layer(id="l0", template="hook", startFrame=0, durationInFrames=50, props={"title": "x"})],
    )
    with pytest.raises(ValueError, match="overlay|slot|kind"):
        validate_spec(spec, CATALOG)


def test_invalid_props_missing_required_field_raises():
    spec = _spec([Scene(id="s0", startFrame=0, durationInFrames=50, template="stat", templateProps={"value": "9"})])
    with pytest.raises(ValueError, match="label|required|stat|s0"):
        validate_spec(spec, CATALOG)


def test_invalid_props_additional_property_raises():
    spec = _spec([Scene(id="s0", startFrame=0, durationInFrames=50, template="hook",
                        templateProps={"title": "Hi", "bogus": 1})])
    with pytest.raises(ValueError):
        validate_spec(spec, CATALOG)


def test_valid_transition_and_overlay_pass():
    spec = _spec(
        [
            Scene(id="s0", startFrame=0, durationInFrames=50, template="hook", templateProps={"title": "Hi"},
                  transition=Transition(template="fade", durationInFrames=10)),
            Scene(id="s1", startFrame=50, durationInFrames=50, template="hook", templateProps={"title": "Bye"}),
        ],
        layers=[Layer(id="l0", template="overlay", startFrame=0, durationInFrames=100, props={"text": "@chan"})],
    )
    validate_spec(spec, CATALOG)  # no raise


# ── catalog loader (integration against the real templates/ folder) ─────────

def test_load_catalog_reads_real_templates():
    import pathlib
    templates_dir = pathlib.Path(__file__).resolve().parents[2] / "templates"
    catalog = load_catalog(templates_dir)
    # the templates committed so far
    for tid in ("hook", "scene", "stat", "outro", "overlay", "fade", "slide", "enumeration"):
        assert tid in catalog, f"{tid} missing from catalog"
    assert catalog["fade"].kind == "transition"
    assert catalog["stat"].kind == "stat"


def test_enumeration_props_validate_against_generated_inputschema():
    import json
    import pathlib
    import jsonschema

    root = pathlib.Path(__file__).resolve().parents[2]
    m = Manifest.model_validate(
        json.loads((root / "templates" / "enumeration" / "manifest.json").read_text(encoding="utf-8"))
    )
    # valid: 2..6 non-empty labels
    jsonschema.validate({"items": ["Sun", "Moon", "Planets"]}, m.inputSchema)
    # invalid: <2 items
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate({"items": ["Sun"]}, m.inputSchema)
    # invalid: extra key (additionalProperties false)
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate({"items": ["Sun", "Moon"], "icon": "x"}, m.inputSchema)
