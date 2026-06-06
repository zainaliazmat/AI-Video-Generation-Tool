"""Step 6.4 — assemble binds a ScenePlan + audio timing + footage into a
validated, multi-template spec.

Key properties under test:
  * GAP-FILLING contiguity — scenes span Sᵢ→Sᵢ₊₁ (last → total), so the
    TransitionSeries path (which lays scenes contiguously) keeps content-start
    pinned to the voiceover frame Sᵢ; Σ durations == total.
  * plan-driven templates/props; footage injected by beat index.
  * transition Tᵢ resolved from the catalog durationFrames, clamped to
    min(dᵢ, dᵢ₊₁); dropped to a hard cut when even the min blend won't fit.
  * clip-length LOOP fallback: clip shorter than dᵢ+Tᵢ → media.loop True.
"""
import json

from pipeline.assemble import build_spec, write_spec
from pipeline.contracts import LineOffset, WordTiming, Clip
from pipeline.recipe import PlannedScene, ScenePlan, TransitionIntent
from manifest import Manifest
from schema import Spec


def _man(id, kind, lo, hi):
    return Manifest(id=id, name=id, version="1.0.0", author="t", apiVersion="1", kind=kind,
                    inputSchema={"type": "object"}, sampleProps={}, durationFrames={"min": lo, "max": hi})


# fade blends 6..30 frames (matches the real fade manifest)
CATALOG = {"fade": _man("fade", "transition", 6, 30), "bigfade": _man("bigfade", "transition", 40, 60)}


def _offsets():
    # S = [0, 36, 96, 126], total = 150 (fps 30)
    return [
        LineOffset(0, "hook", 0.0, 1.0),
        LineOffset(1, "scene", 1.2, 3.0),
        LineOffset(2, "stat", 3.2, 4.0),
        LineOffset(3, "outro", 4.2, 5.0),
    ]


def _plan(*, scene_transition=None):
    return ScenePlan(title="My Title", scenes=[
        PlannedScene("hook", "hook", {"title": "My Title", "subtitle": "hook"}, needs_footage=False),
        PlannedScene("scene", "scene", {}, needs_footage=True, query="ocean", transition=scene_transition),
        PlannedScene("stat", "stat", {"value": "9", "label": "x"}, needs_footage=False),
        PlannedScene("outro", "outro", {"title": "follow"}, needs_footage=False),
    ])


def _clips(scene_clip_frames=300):
    return [Clip(index=1, query="ocean", path="assets/ocean.mp4", duration_frames=scene_clip_frames)]


def _build(plan, clips=None, **kw):
    return build_spec(plan, _offsets(), [WordTiming("hi", 0, 10)], clips if clips is not None else _clips(),
                      catalog=CATALOG, fps=30, **kw)


def test_meta_and_contiguous_gap_filling_durations():
    spec = _build(_plan())
    assert spec.meta.title == "My Title"
    assert spec.meta.durationInFrames == 150
    starts = [s.startFrame for s in spec.scenes]
    durs = [s.durationInFrames for s in spec.scenes]
    assert starts == [0, 36, 96, 126]
    assert durs == [36, 60, 30, 24]            # span Sᵢ→Sᵢ₊₁ (last → total)
    assert sum(durs) == 150                     # contiguous, no gaps


def test_templates_and_props_from_plan():
    spec = _build(_plan())
    assert [s.template for s in spec.scenes] == ["hook", "scene", "stat", "outro"]
    assert spec.scenes[0].templateProps == {"title": "My Title", "subtitle": "hook"}
    assert spec.scenes[2].templateProps == {"value": "9", "label": "x"}
    assert spec.scenes[3].templateProps == {"title": "follow"}


def test_footage_injected_by_beat_index_with_kenburns_alias():
    spec = _build(_plan())
    media = spec.scenes[1].templateProps["media"]
    assert media["src"] == "assets/ocean.mp4"
    assert media["type"] == "video"
    data = spec.model_dump(by_alias=True)
    kb = data["scenes"][1]["templateProps"]["media"]["kenBurns"]
    assert "from" in kb and "from_" not in kb


def test_transition_resolved_and_clamped():
    # fade max=30; fit = min(d1=60, d2=30) = 30 -> T = 30
    spec = _build(_plan(scene_transition=TransitionIntent("fade", {})))
    t = spec.scenes[1].transition
    assert t is not None
    assert t.template == "fade"
    assert t.durationInFrames == 30


def test_transition_dropped_when_min_blend_does_not_fit():
    # bigfade min=40; fit = min(60,30)=30 < 40 -> hard cut (no transition)
    spec = _build(_plan(scene_transition=TransitionIntent("bigfade", {})))
    assert spec.scenes[1].transition is None


def test_loop_fallback_when_clip_shorter_than_span():
    # scene span = d1(60) + T(30) = 90; clip 60 frames < 90 -> loop
    spec = _build(_plan(scene_transition=TransitionIntent("fade", {})), clips=_clips(scene_clip_frames=60))
    assert spec.scenes[1].templateProps["media"]["loop"] is True


def test_no_loop_when_clip_long_enough():
    spec = _build(_plan(scene_transition=TransitionIntent("fade", {})), clips=_clips(scene_clip_frames=300))
    assert spec.scenes[1].templateProps["media"]["loop"] is False


def test_no_loop_when_duration_unknown():
    spec = _build(_plan(), clips=[Clip(index=1, query="ocean", path="assets/o.mp4", duration_frames=None)])
    assert spec.scenes[1].templateProps["media"]["loop"] is False


def test_theme_and_layers_defaults_and_roundtrip(tmp_path):
    spec = _build(_plan())
    assert spec.theme.caption.color == "#FFFFFF"
    data = spec.model_dump(by_alias=True)
    assert data["layers"] == []
    assert "style" not in data
    out = tmp_path / "spec.json"
    write_spec(spec, out)
    Spec.model_validate(json.loads(out.read_text()))   # must not raise
