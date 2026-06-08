"""End-to-end: an enumeration scene validates against the REAL template catalog
(slot/kind + props against the generated inputSchema), proving the plugin is
render-ready without the MissingTemplate placeholder."""
import pathlib

import pytest

from schema import Spec, Scene, Meta, Audio
from pipeline.validate import load_catalog, validate_spec

_ROOT = pathlib.Path(__file__).resolve().parents[2]


def _spec(items):
    return Spec(
        meta=Meta(title="T", durationInFrames=300),
        audio=Audio(voiceover="assets/voiceover.wav"),
        scenes=[
            Scene(
                id="s1", startFrame=0, durationInFrames=300,
                template="enumeration", templateProps={"items": items},
            )
        ],
        captions=[],
    )


def test_enumeration_spec_validates_end_to_end():
    catalog = load_catalog(_ROOT / "templates")
    validate_spec(_spec(["Sun", "Moon", "Planets"]), catalog)  # must not raise


def test_enumeration_spec_rejects_bad_props():
    catalog = load_catalog(_ROOT / "templates")
    with pytest.raises(ValueError):
        validate_spec(_spec(["Sun"]), catalog)  # <2 items → fail fast before render
