"""Studio v2 — Timing fix-a-word: edits the caption TOKEN only, frames pinned."""
import json

import pytest

from schema import Theme
from session import store, engine, executors, codecs
from pipeline.contracts import WordTiming


def _ctx(tmp_path):
    return executors.EngineContext(
        topic="T", fps=30, theme=Theme(), catalog={}, assets_dir=tmp_path,
        cache_dir=tmp_path, voiceover_path=tmp_path / "v.wav",
        spec_out=tmp_path / "s.json", sources_out=tmp_path / "src.json")


def _seed_timing(tmp_path):
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="s1", topic="T", now="t0")
    words = [WordTiming("kilo", 0, 10), WordTiming("metres", 10, 20)]
    store.upsert_stage(conn, "s1", "timing", status="done", input_hash="h",
                       output_json=json.dumps(codecs.words_to_json(words)), now="t0")
    # assemble (downstream of timing) deps on script/voice/footage too — seed truthy
    # stubs so its re-derive can load inputs.
    for st in ["script", "voice", "footage"]:
        store.upsert_stage(conn, "s1", st, status="done", input_hash="h",
                           output_json="{}", now="t0")
    return conn


def test_fix_word_changes_text_keeps_frames(tmp_path, monkeypatch):
    conn = _seed_timing(tmp_path)
    for st in ["script", "voice", "footage"]:
        monkeypatch.setitem(engine.CODECS, st, (lambda o: o, lambda d: d))
    ran = []
    monkeypatch.setitem(engine.EXECUTORS, "assemble", lambda ctx, inp: ran.append("assemble") or {})
    monkeypatch.setitem(engine.CODECS, "assemble", (lambda o: o, lambda d: d))
    monkeypatch.setattr(engine.Engine, "materialize_spec", lambda self: None)

    eng = engine.Engine(conn, _ctx(tmp_path), session_id="s1")
    eng.edit("timing", {"op": "fix_word", "index": 1, "text": "kilometres"})

    words = eng._load_output("timing")
    assert words[1].text == "kilometres"
    assert words[1].start_frame == 10 and words[1].end_frame == 20   # frames PINNED
    assert words[0].text == "kilo"                                   # untouched
    assert ran == ["assemble"]                                       # captions rebuilt
    conn.close()


def test_fix_word_rejects_empty_and_out_of_range(tmp_path, monkeypatch):
    conn = _seed_timing(tmp_path)
    monkeypatch.setattr(engine.Engine, "materialize_spec", lambda self: None)
    eng = engine.Engine(conn, _ctx(tmp_path), session_id="s1")
    with pytest.raises(ValueError):
        eng.edit("timing", {"op": "fix_word", "index": 0, "text": "   "})
    with pytest.raises(IndexError):
        eng.edit("timing", {"op": "fix_word", "index": 9, "text": "x"})
    conn.close()
