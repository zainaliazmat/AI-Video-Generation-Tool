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


def test_script_bundle_roundtrip():
    script = BeatsScript(title="T", beats=[Beat(text="h"), Beat(text="scene"), Beat(text="o")])
    p = recipe_plan(script, theme=Theme())
    j = codecs.script_bundle_to_json({"script": script, "plan": p})
    back = codecs.script_bundle_from_json(j)
    assert back["script"].title == "T"
    assert [s.role for s in back["plan"].scenes] == [s.role for s in p.scenes]
    assert back["plan"].scenes[1].needs_footage == p.scenes[1].needs_footage
    assert back["plan"].scenes[1].query == p.scenes[1].query
