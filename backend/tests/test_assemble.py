import json
from pipeline.assemble import build_spec, write_spec
from pipeline.contracts import LineOffset, WordTiming, Clip
from schema import Spec


def _fixture():
    # Offsets chosen off the .5-frame boundary so round() is unambiguous.
    offsets = [LineOffset(0, "a", 0.0, 1.0), LineOffset(1, "b", 1.2, 3.0)]
    words = [WordTiming("a", 0, 15), WordTiming("b", 36, 88)]
    clips = [Clip(0, "a", "assets/footage_0.mp4"), Clip(1, "b", "assets/footage_1.mp4")]
    return offsets, words, clips


def test_build_spec_timing_and_structure():
    offsets, words, clips = _fixture()
    spec = build_spec("My Title", offsets, words, clips, fps=30)
    assert spec.meta.durationInFrames == 90          # round(3.0 * 30)
    assert spec.scenes[0].startFrame == 0
    assert spec.scenes[0].durationInFrames == 30     # round(1.0*30) - 0
    assert spec.scenes[1].startFrame == 36           # round(1.2*30)
    assert spec.scenes[1].durationInFrames == 54     # round(3.0*30) - round(1.2*30)
    # Phase-2: scenes route through the `scene` template; media moves into
    # templateProps (top-level media is now unused by the generator).
    assert spec.scenes[0].template == "scene"
    assert spec.scenes[0].media is None
    assert spec.scenes[1].templateProps["media"]["src"] == "assets/footage_1.mp4"
    assert len(spec.captions) == 2


def test_kenburns_from_alias_serialization():
    offsets, words, clips = _fixture()
    spec = build_spec("T", offsets, words, clips, fps=30)
    data = spec.model_dump(by_alias=True)
    kb = data["scenes"][0]["templateProps"]["media"]["kenBurns"]
    assert "from" in kb and "from_" not in kb        # #1 contract gotcha
    assert kb["from"] == 1.0


def test_build_spec_emits_theme_not_style():
    # Phase-2 fold: assemble produces `theme` (with caption styling nested under
    # theme.caption), never the old top-level `style`. layers default to [].
    offsets, words, clips = _fixture()
    spec = build_spec("T", offsets, words, clips, fps=30)
    assert spec.theme.caption.color == "#FFFFFF"
    data = spec.model_dump(by_alias=True)
    assert "style" not in data
    assert "theme" in data and "caption" in data["theme"]
    assert data["layers"] == []


def test_write_spec_roundtrips_through_schema(tmp_path):
    offsets, words, clips = _fixture()
    spec = build_spec("T", offsets, words, clips, fps=30)
    out = tmp_path / "spec.json"
    write_spec(spec, out)
    loaded = json.loads(out.read_text())
    assert "from" in loaded["scenes"][0]["templateProps"]["media"]["kenBurns"]
    Spec.model_validate(loaded)                       # must not raise
