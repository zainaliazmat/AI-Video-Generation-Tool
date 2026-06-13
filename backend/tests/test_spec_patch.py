"""Studio v3 M4 — spec_patch whitelist regression tests (T2).

check_path already admits `scenes[i].templateProps.*` via ALLOWED_SCENE_FIELDS,
so backgroundClip and its sub-fields are patchable by design.  These tests
pin that guarantee and re-pin the invariant that scenes[i].durationInFrames
is ALWAYS fenced.

No code was changed for these tests — this is a pure ground-truth regression.
"""
import pytest

from pipeline.spec_patch import check_path, apply_patch, PatchError
from schema import Spec, Meta, Audio, Scene, Caption, Theme


# ── helpers ──────────────────────────────────────────────────────────────────

def _minimal_spec(extra_template_props=None) -> Spec:
    """A two-scene spec where scene 1 is a hero (hook) with optional templateProps."""
    template_props = {"title": "Test hook", **(extra_template_props or {})}
    return Spec(
        meta=Meta(title="T", durationInFrames=120),
        audio=Audio(voiceover="assets/v.wav"),
        scenes=[
            Scene(id="s0", startFrame=0, durationInFrames=60,
                  template="hook", templateProps=template_props),
            Scene(id="s1", startFrame=60, durationInFrames=60,
                  template="stat", templateProps={"value": "42%", "label": "x"}),
        ],
        captions=[Caption(text="hi", startFrame=0, endFrame=30)],
        theme=Theme(),
        layers=[],
    )


# ── check_path whitelist tests ────────────────────────────────────────────────

def test_backgroundClip_path_passes_check_path():
    """scenes/1/templateProps/backgroundClip is allowed by the whitelist
    (templateProps ∈ ALLOWED_SCENE_FIELDS — parts[2] is the only gate)."""
    check_path("/scenes/1/templateProps/backgroundClip")  # must not raise


def test_backgroundClip_sub_field_path_passes_check_path():
    """scenes/1/templateProps/backgroundClip/src is allowed — any depth under
    templateProps is patchable."""
    check_path("/scenes/1/templateProps/backgroundClip/src")  # must not raise


def test_durationInFrames_still_rejected():
    """scenes/i/durationInFrames is ALWAYS fenced — this is the belt-and-suspenders
    guarantee that the Assemble gate cannot change timing."""
    with pytest.raises(PatchError, match="timing|identity|durationInFrames"):
        check_path("/scenes/1/durationInFrames")


# ── apply_patch + Spec.model_validate round-trip ─────────────────────────────

def test_apply_patch_adds_backgroundClip_and_spec_validates():
    """Post-apply Spec.model_validate accepts a patched spec carrying a valid
    backgroundClip on a hero scene."""
    spec = _minimal_spec()
    patch = [
        {
            "op": "replace",
            "path": "/scenes/0/templateProps",
            "value": {
                "title": "Test hook",
                "backgroundClip": {
                    "type": "video",
                    "src": "assets/hero-bg.mp4",
                    "fit": "cover",
                    "kenBurns": {
                        "from": 1.0,
                        "to": 1.12,
                        "originX": 0.5,
                        "originY": 0.5,
                    },
                    "loop": False,
                },
            },
        }
    ]
    patched = apply_patch(spec, patch)
    # The Spec round-tripped through model_validate without error.
    assert patched.scenes[0].templateProps["backgroundClip"]["type"] == "video"
    assert patched.scenes[0].templateProps["backgroundClip"]["src"] == "assets/hero-bg.mp4"


def test_apply_patch_with_backgroundClip_preserves_invariants():
    """Patching templateProps to add backgroundClip does not touch timing/audio/captions."""
    spec = _minimal_spec()
    patch = [
        {
            "op": "replace",
            "path": "/scenes/0/templateProps",
            "value": {
                "title": "Updated title",
                "backgroundClip": {
                    "type": "image",
                    "src": "assets/hero-poster.jpg",
                },
            },
        }
    ]
    patched = apply_patch(spec, patch)
    # timing invariants intact
    assert patched.scenes[0].startFrame == 0
    assert patched.scenes[0].durationInFrames == 60
    assert patched.meta.durationInFrames == 120
    assert patched.audio.voiceover == "assets/v.wav"
    assert patched.captions[0].text == "hi"


def test_durationInFrames_patch_still_rejected_by_apply_patch():
    """apply_patch also rejects a durationInFrames change — belt-and-suspenders
    re-pinned (invariant check fires even if check_path somehow passed)."""
    spec = _minimal_spec()
    with pytest.raises(PatchError):
        apply_patch(spec, [{"op": "replace", "path": "/scenes/0/durationInFrames", "value": 999}])
