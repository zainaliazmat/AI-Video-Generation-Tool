"""Studio v2 — Voice gate backend: voice threading, voice catalog, sidecar persist."""
from pathlib import Path

from schema import Theme
from pipeline import tts as tts_stage
from pipeline import projects as projects_mod
from session import executors


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
