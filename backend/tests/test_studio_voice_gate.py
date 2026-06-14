"""Studio v2 — Voice gate backend: voice threading, voice catalog, sidecar persist.

M3 additions: preview() retargeted to beat-1 text (first ≤12 words), (voice,text,speed)
cache key, sid fallback to canned line, and the zero-LLM-cost invariant (PRD §6.1).
"""

import hashlib
import json

import pytest

from schema import Theme
from pipeline import tts as tts_stage
from pipeline import projects as projects_mod
from session import executors
import session_voice as sv
from session import store, codecs
from pipeline.content import Beat, BeatsScript


def test_voice_catalog_is_all_free_and_has_ids():
    assert len(tts_stage.VOICES) >= 6
    for v in tts_stage.VOICES:
        assert v["id"] and v["name"] and v["character"] and v["lang"] in ("a", "b")
    assert tts_stage.is_valid_voice("af_bella")
    assert not tts_stage.is_valid_voice("nope_voice")


def test_lang_for_voice():
    assert tts_stage.lang_for_voice("af_heart") == "a"
    assert tts_stage.lang_for_voice("bf_emma") == "b"
    assert tts_stage.lang_for_voice("unknown") == "a"   # safe default


def test_synthesize_threads_voice_and_speed_to_pipeline(tmp_path):
    seen = {}

    class FakePipeline:
        def __call__(self, line, voice, speed):
            seen["voice"] = voice
            seen["speed"] = speed
            import numpy as np
            yield None, None, np.ones(tts_stage.SAMPLE_RATE, dtype="float32")

    out = tmp_path / "vo.wav"
    tts_stage.synthesize(["hello"], out, pipeline=FakePipeline(), voice="am_adam", speed=1.1)
    assert seen == {"voice": "am_adam", "speed": 1.1}
    assert out.exists()


def test_run_voice_passes_selected_voice(monkeypatch, tmp_path):
    captured = {}
    monkeypatch.setattr(tts_stage, "synthesize",
                        lambda lines, path, **kw: captured.update(kw) or [])
    ctx = executors.EngineContext(
        topic="T", fps=30, theme=Theme(), catalog={}, assets_dir=tmp_path,
        cache_dir=tmp_path, voiceover_path=tmp_path / "v.wav",
        spec_out=tmp_path / "s.json", sources_out=tmp_path / "src.json",
        voice="bf_emma", speed=1.2)

    class _S:
        beats = [type("B", (), {"text": "a"})()]
    executors.run_voice(ctx, {"script": {"script": _S()}})
    assert captured == {"voice": "bf_emma", "speed": 1.2}


def test_run_voice_default_voice_is_byte_identical_call(monkeypatch, tmp_path):
    # default voice/speed -> NO kwargs passed (keeps legacy 2-arg stubs valid)
    captured = {"kw": None}
    monkeypatch.setattr(tts_stage, "synthesize",
                        lambda lines, path, **kw: captured.__setitem__("kw", kw) or [])
    ctx = executors.EngineContext(
        topic="T", fps=30, theme=Theme(), catalog={}, assets_dir=tmp_path,
        cache_dir=tmp_path, voiceover_path=tmp_path / "v.wav",
        spec_out=tmp_path / "s.json", sources_out=tmp_path / "src.json")

    class _S:
        beats = [type("B", (), {"text": "a"})()]
    executors.run_voice(ctx, {"script": {"script": _S()}})
    assert captured["kw"] == {}


def test_voice_sidecar_round_trip(tmp_path):
    sid = "auto-xyz"
    (tmp_path / "projects" / sid).mkdir(parents=True)
    assert projects_mod.read_voice(tmp_path, sid)["voice"] == "af_heart"  # default
    projects_mod.write_voice(tmp_path, sid, voice="af_sky", speed=0.9)
    got = projects_mod.read_voice(tmp_path, sid)
    assert got == {"voice": "af_sky", "speed": 0.9}


# ---------------------------------------------------------------------------
# M3: preview() retargeted to beat-1 text — (voice, text, speed) cache key
# ---------------------------------------------------------------------------

def _seed_db(tmp_path, beats):
    """Write a minimal sessions.db with one session + completed script stage."""
    from pipeline import recipe as recipe_stage
    db = tmp_path / "s.db"
    conn = store.connect(db)
    store.create_session(conn, id="s1", topic="T", now="t0")
    script = BeatsScript(title="T", beats=beats)
    plan = recipe_stage.plan(script, theme=Theme(), manifests={})
    store.upsert_stage(
        conn, "s1", "script", status="done", input_hash="h",
        output_json=json.dumps(codecs.script_bundle_to_json({"script": script, "plan": plan})),
        now="t0",
    )
    conn.close()
    return db


def _fake_synth(calls: list):
    """Return a tts_stage.synthesize replacement that appends (lines, kw) to calls."""
    from pathlib import Path
    def _synth(lines, path, **kw):
        calls.append({"lines": list(lines), "kw": kw})
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_bytes(b"W")
        return []
    return _synth


# T1-A: same (voice, text, speed) → synthesize called only once (cache hit).
def test_preview_same_voice_text_speed_synthesizes_once(monkeypatch, tmp_path):
    monkeypatch.setattr("session.job_ctx.ASSETS_DIR", tmp_path / "a")
    calls = []
    monkeypatch.setattr(tts_stage, "synthesize", _fake_synth(calls))
    sv.preview("af_bella", speed=1.0)          # first call — synthesizes
    sv.preview("af_bella", speed=1.0)          # second call — cache hit
    assert len(calls) == 1


# T1-B: different speed → new file, new synthesis.
def test_preview_different_speed_synthesizes_again(monkeypatch, tmp_path):
    monkeypatch.setattr("session.job_ctx.ASSETS_DIR", tmp_path / "a")
    calls = []
    monkeypatch.setattr(tts_stage, "synthesize", _fake_synth(calls))
    sv.preview("af_bella", speed=1.0)
    sv.preview("af_bella", speed=1.1)
    assert len(calls) == 2


# T1-C: different beat text (different hash) → new synthesis.
def test_preview_different_text_synthesizes_again(monkeypatch, tmp_path):
    monkeypatch.setattr("session.job_ctx.ASSETS_DIR", tmp_path / "a")
    monkeypatch.setattr("session.job_ctx.SESSIONS_DB", tmp_path / "s.db")
    calls = []
    monkeypatch.setattr(tts_stage, "synthesize", _fake_synth(calls))
    # First: no sid → canned line.
    sv.preview("af_bella", speed=1.0)
    # Second: sid with a different beat text → new hash → new synthesis.
    db = _seed_db(tmp_path, [Beat(text="Completely different opening line")])
    monkeypatch.setattr("session.job_ctx.SESSIONS_DB", db)
    sv.preview("af_bella", speed=1.0, sid="s1")
    assert len(calls) == 2


# T1-D: invalid voice → raises ValueError (existing behavior preserved).
def test_preview_invalid_voice_raises(monkeypatch, tmp_path):
    monkeypatch.setattr("session.job_ctx.ASSETS_DIR", tmp_path / "a")
    with pytest.raises(ValueError, match="unknown voice"):
        sv.preview("not_a_real_voice")


# T1-E: sid given + script exists → synthesized text is beat-1's first ≤12 words.
def test_preview_sid_with_script_uses_beat1_text(monkeypatch, tmp_path):
    long_hook = "one two three four five six seven eight nine ten eleven twelve thirteen extra"
    db = _seed_db(tmp_path, [Beat(text=long_hook), Beat(text="second beat")])
    monkeypatch.setattr("session.job_ctx.SESSIONS_DB", db)
    monkeypatch.setattr("session.job_ctx.ASSETS_DIR", tmp_path / "a")
    calls = []
    monkeypatch.setattr(tts_stage, "synthesize", _fake_synth(calls))
    sv.preview("af_bella", sid="s1")
    assert len(calls) == 1
    synthesized_text = calls[0]["lines"][0]
    words = synthesized_text.split()
    assert len(words) <= 12
    assert synthesized_text == " ".join(long_hook.split()[:12])


# T1-F: sid given + no script → canned line used, no crash.
def test_preview_sid_no_script_falls_back_to_canned(monkeypatch, tmp_path):
    db = tmp_path / "empty.db"
    conn = store.connect(db)
    store.create_session(conn, id="s1", topic="T", now="t0")
    conn.close()
    monkeypatch.setattr("session.job_ctx.SESSIONS_DB", db)
    monkeypatch.setattr("session.job_ctx.ASSETS_DIR", tmp_path / "a")
    calls = []
    monkeypatch.setattr(tts_stage, "synthesize", _fake_synth(calls))
    result = sv.preview("af_bella", sid="s1")
    assert result["ok"] is True
    assert len(calls) == 1
    assert calls[0]["lines"][0] == sv.SAMPLE_LINE


# T1-G: cache filename contains (voice, text_hash, speed) — not just (voice, speed).
def test_preview_cache_filename_includes_text_hash(monkeypatch, tmp_path):
    monkeypatch.setattr("session.job_ctx.ASSETS_DIR", tmp_path / "a")
    calls = []
    monkeypatch.setattr(tts_stage, "synthesize", _fake_synth(calls))
    result = sv.preview("af_bella", speed=1.0)
    expected_hash = hashlib.sha1(sv.SAMPLE_LINE.encode()).hexdigest()[:12]
    assert f"af_bella_{expected_hash}_1_0" in result["path"]


# T1-H: zero LLM / retrieval cost invariant (PRD §6.1).
# preview() must never call generate_grounded_script or retrieve.
def test_preview_never_calls_llm_or_retrieval(monkeypatch, tmp_path):
    db = _seed_db(tmp_path, [Beat(text="Hook beat text for the video")])
    monkeypatch.setattr("session.job_ctx.SESSIONS_DB", db)
    monkeypatch.setattr("session.job_ctx.ASSETS_DIR", tmp_path / "a")
    monkeypatch.setattr(tts_stage, "synthesize", _fake_synth([]))

    def _no_llm(*a, **kw):
        raise AssertionError("preview called generate_grounded_script — must not touch LLM")

    def _no_retrieval(*a, **kw):
        raise AssertionError("preview called retrieve — must not touch retrieval/Tavily")

    monkeypatch.setattr("pipeline.script.generate_grounded_script", _no_llm)
    monkeypatch.setattr("pipeline.retrieval.retrieve", _no_retrieval)

    # Should complete without triggering either guard.
    result = sv.preview("af_bella", sid="s1")
    assert result["ok"] is True
