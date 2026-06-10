"""HITL A.1 — per-stage JSON codecs. Every stage output must round-trip through
JSON (it's persisted in SQLite and re-loaded to feed downstream stages)."""
from pipeline.contracts import LineOffset, WordTiming, Clip
from pipeline.content import Beat, BeatsScript
from pipeline.recipe import plan as recipe_plan
from schema import Theme
from session import codecs


def test_offsets_roundtrip():
    offs = [LineOffset(0, "hi", 0.0, 1.0), LineOffset(1, "yo", 1.0, 2.5)]
    assert codecs.offsets_from_json(codecs.offsets_to_json(offs)) == offs


def test_words_roundtrip():
    ws = [WordTiming("a", 0, 3), WordTiming("b", 3, 9)]
    assert codecs.words_from_json(codecs.words_to_json(ws)) == ws


def test_clips_roundtrip():
    cs = [Clip(index=1, query="q", path="assets/x.mp4", duration_frames=120),
          Clip(index=2, query="q2", path="assets/y.mp4", duration_frames=None)]
    assert codecs.clips_from_json(codecs.clips_to_json(cs)) == cs


def test_clip_kind_round_trips_and_defaults_video():
    from pipeline.contracts import Clip
    from session.codecs import clips_to_json, clips_from_json

    # default kind is "video"
    c = Clip(index=0, query="q", path="assets/x.mp4", duration_frames=10)
    assert c.kind == "video"

    # an image clip round-trips through the footage codec
    img = Clip(index=1, query="pic.png", path="assets/pic.png",
               duration_frames=None, kind="image")
    restored = clips_from_json(clips_to_json([c, img]))
    assert restored[0].kind == "video"
    assert restored[1].kind == "image"

    # legacy JSON missing the key loads with the default (forward-compat)
    legacy = [{"index": 0, "query": "q", "path": "assets/x.mp4",
               "duration_frames": 10}]
    assert clips_from_json(legacy)[0].kind == "video"


def test_script_bundle_roundtrip():
    script = BeatsScript(title="T", beats=[Beat(text="h"), Beat(text="scene"), Beat(text="o")])
    p = recipe_plan(script, theme=Theme())
    j = codecs.script_bundle_to_json({"script": script, "plan": p})
    back = codecs.script_bundle_from_json(j)
    assert back["script"].title == "T"
    assert [s.role for s in back["plan"].scenes] == [s.role for s in p.scenes]
    assert back["plan"].scenes[1].needs_footage == p.scenes[1].needs_footage
    assert back["plan"].scenes[1].query == p.scenes[1].query
    # template + props route the renderer; transition is load-bearing too — lock them
    assert [s.template for s in back["plan"].scenes] == [s.template for s in p.scenes]
    assert [s.props for s in back["plan"].scenes] == [s.props for s in p.scenes]
    assert [(s.transition.template, s.transition.props) if s.transition else None
            for s in back["plan"].scenes] == \
           [(s.transition.template, s.transition.props) if s.transition else None
            for s in p.scenes]


def test_footage_bundle_roundtrip():
    bundle = {"clips": [Clip(index=0, query="q", path="assets/a.mp4", duration_frames=120),
                        Clip(index=2, query="q2", path="assets/b.mp4", duration_frames=None)],
              "candidates": {2: [{"rank": 1, "query": "q2", "thumb_url": "t", "selected": 1}]}}
    back = codecs.footage_from_json(codecs.footage_to_json(bundle))
    assert back["clips"] == bundle["clips"]
    assert 2 in back["candidates"]                      # int scene-index key restored
    assert back["candidates"][2] == bundle["candidates"][2]


def test_spec_roundtrip_preserves_from_alias():
    from schema import Spec
    d = {
        "meta": {"title": "T", "fps": 30, "width": 1080, "height": 1920, "durationInFrames": 90},
        "audio": {"voiceover": "assets/voiceover.wav", "music": None, "musicVolumeDb": -18.0},
        "scenes": [{
            "id": "s1", "startFrame": 0, "durationInFrames": 90,
            "media": {"type": "video", "src": "assets/clip.mp4", "fit": "cover",
                      "kenBurns": {"from": 1.0, "to": 1.1, "originX": 0.5, "originY": 0.5}},
        }],
        "captions": [{"text": "hi", "startFrame": 0, "endFrame": 30}],
        "theme": {"caption": {"fontFamily": "Inter", "fontWeight": 800, "color": "#FFFFFF",
                              "highlightColor": "#FFE600", "strokeColor": "#000000", "positionY": 0.78}},
    }
    j = codecs.spec_to_json(Spec.model_validate(d))
    assert j["scenes"][0]["media"]["kenBurns"]["from"] == 1.0   # alias emitted as `from`, not `from_`
    # round-trip is stable: from_json -> to_json reproduces the same dict
    assert codecs.spec_to_json(codecs.spec_from_json(j)) == j
