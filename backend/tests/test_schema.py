"""Tests for the spec.json contract (backend/schema.py) after the Phase-2
contract extension:

  - `style` is folded into `theme.caption` (breaking rename).
  - new top-level `theme` (palette / fonts / transition / caption).
  - new top-level `layers` (overlay-only this phase; optional, defaults []).
  - scenes gain optional `template`, `templateProps`, `transition`.

These additive scene/layer fields are OPTIONAL so existing specs still validate;
the renderer ignores them until later steps.
"""
from schema import Spec


def _spec_dict(**over) -> dict:
    d = {
        "meta": {"title": "T", "fps": 30, "width": 1080, "height": 1920, "durationInFrames": 90},
        "audio": {"voiceover": "assets/voiceover.wav", "music": None, "musicVolumeDb": -18.0},
        "scenes": [
            {
                "id": "s1",
                "startFrame": 0,
                "durationInFrames": 90,
                "media": {
                    "type": "video",
                    "src": "assets/clip.mp4",
                    "fit": "cover",
                    "kenBurns": {"from": 1.0, "to": 1.1, "originX": 0.5, "originY": 0.5},
                },
            }
        ],
        "captions": [{"text": "hi", "startFrame": 0, "endFrame": 30}],
        "theme": {
            "caption": {
                "fontFamily": "Inter",
                "fontWeight": 800,
                "color": "#FFFFFF",
                "highlightColor": "#FFE600",
                "strokeColor": "#000000",
                "positionY": 0.78,
            }
        },
    }
    d.update(over)
    return d


def test_style_field_folded_into_theme():
    # The breaking rename: `style` is gone, `theme` is the contract field.
    assert "style" not in Spec.model_fields
    assert "theme" in Spec.model_fields


def test_new_shape_validates_and_reads_caption_under_theme():
    spec = Spec.model_validate(_spec_dict())
    assert spec.theme.caption.color == "#FFFFFF"
    assert spec.theme.caption.highlightColor == "#FFE600"
    assert spec.theme.caption.positionY == 0.78


def test_theme_supplies_defaults_when_minimal():
    spec = Spec.model_validate(_spec_dict(theme={}))
    assert spec.theme.caption.fontWeight == 800        # default
    assert spec.theme.palette.background == "#000000"  # palette exists with a default
    assert spec.theme.fonts.heading                    # font pairing exists


def test_layers_default_empty_and_accept_an_overlay():
    assert Spec.model_validate(_spec_dict()).layers == []
    layered = Spec.model_validate(
        _spec_dict(layers=[{"id": "l1", "template": "logo-bug", "startFrame": 0, "durationInFrames": 90}])
    )
    assert layered.layers[0].template == "logo-bug"


def test_scene_media_is_optional_for_template_scenes():
    # A template-driven scene carries its media in templateProps; the top-level
    # `media` field is now optional (e.g. a stat scene has no footage).
    d = _spec_dict()
    del d["scenes"][0]["media"]
    d["scenes"][0]["template"] = "scene"
    d["scenes"][0]["templateProps"] = {"media": {"type": "video", "src": "a.mp4", "fit": "cover"}}
    spec = Spec.model_validate(d)
    assert spec.scenes[0].media is None
    assert spec.scenes[0].template == "scene"


def test_scene_template_fields_optional_and_roundtrip():
    # Backward compatible: a scene without the new fields still validates.
    assert Spec.model_validate(_spec_dict()).scenes[0].template is None

    with_tpl = _spec_dict()
    with_tpl["scenes"][0]["template"] = "scene"
    with_tpl["scenes"][0]["templateProps"] = {"src": "assets/clip.mp4"}
    with_tpl["scenes"][0]["transition"] = {"template": "fade", "durationInFrames": 15}
    spec = Spec.model_validate(with_tpl)
    assert spec.scenes[0].template == "scene"
    assert spec.scenes[0].transition.template == "fade"

    dumped = spec.model_dump(by_alias=True)
    assert dumped["scenes"][0]["template"] == "scene"
    # kenBurns alias gotcha must still hold after the contract change.
    assert "from" in dumped["scenes"][0]["media"]["kenBurns"]
