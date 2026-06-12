"""Studio v3 M2 — target_length threading: store → ctx → executor → CLI, hash-invalidating.

Tests:
  1. EngineContext.target_length defaults to 60
  2. run_script passes system_prompt_for(target_length) to generate_grounded_script
     — default 60 passes no system_prompt kwarg (byte-identical golden behavior)
     — non-default 180 passes system_prompt=system_prompt_for(180)
  3. _input_hash includes target_length: same session, flip ctx.target_length,
     script stage re-runs (cache miss)
  4. build_ctx threads target_length into EngineContext
  5. api.create stores target_length on the session row
  6. start() + _resume() round-trip: create with 180, _resume builds ctx with 180
"""
from __future__ import annotations

from pathlib import Path

import pytest

from schema import Theme
from pipeline.content import Beat, BeatsScript
from pipeline.contracts import LineOffset, WordTiming, Clip
from pipeline import validate as validate_stage
from pipeline import script as script_stage
from session import store, engine as eng_mod, executors, api as session_api
from session.executors import EngineContext
from session import job_ctx


_TEMPLATES = Path(__file__).resolve().parents[2] / "templates"


def _ctx(tmp_path, *, target_length: int = 60, **over):
    base = dict(
        topic="Reefs", fps=30, theme=Theme(), catalog={},
        assets_dir=tmp_path, cache_dir=tmp_path / "cache",
        voiceover_path=tmp_path / "voiceover.wav",
        spec_out=tmp_path / "spec.json", sources_out=tmp_path / "sources.json",
        target_length=target_length,
    )
    base.update(over)
    return EngineContext(**base)


# ---------------------------------------------------------------------------
# 1. EngineContext defaults
# ---------------------------------------------------------------------------

def test_engine_context_target_length_defaults_to_60(tmp_path):
    ctx = EngineContext(
        topic="T", fps=30, theme=Theme(), catalog={},
        assets_dir=tmp_path, cache_dir=tmp_path / "c",
        voiceover_path=tmp_path / "v.wav",
        spec_out=tmp_path / "spec.json", sources_out=tmp_path / "sources.json",
    )
    assert ctx.target_length == 60


# ---------------------------------------------------------------------------
# 2. run_script passes system_prompt_for(target_length) through
# ---------------------------------------------------------------------------

def test_run_script_default_60_does_not_pass_system_prompt_kwarg(tmp_path, monkeypatch):
    """Default 60: run_script must NOT pass system_prompt kwarg (byte-identical golden path)."""
    captured = {}

    def fake_generate(topic, cache_dir=None, **kw):
        captured.update(kw)
        return BeatsScript(title="T", beats=[Beat(text="hook"), Beat(text="out")])

    monkeypatch.setattr("pipeline.script.generate_grounded_script", fake_generate)

    executors.run_script(_ctx(tmp_path, target_length=60), {})

    assert "system_prompt" not in captured, (
        "run_script should NOT pass system_prompt for target_length=60 "
        "(system_prompt_for(60) == SYSTEM_PROMPT — golden path)"
    )


def test_run_script_non_default_passes_system_prompt_kwarg(tmp_path, monkeypatch):
    """Non-default preset (180): run_script must pass system_prompt=system_prompt_for(180)."""
    captured = {}

    def fake_generate(topic, cache_dir=None, **kw):
        captured.update(kw)
        return BeatsScript(title="T", beats=[Beat(text="hook"), Beat(text="out")])

    monkeypatch.setattr("pipeline.script.generate_grounded_script", fake_generate)

    executors.run_script(_ctx(tmp_path, target_length=180), {})

    assert "system_prompt" in captured
    assert captured["system_prompt"] == script_stage.system_prompt_for(180)
    assert captured["system_prompt"] != script_stage.SYSTEM_PROMPT


def test_run_script_30_passes_correct_system_prompt(tmp_path, monkeypatch):
    """30s preset: run_script passes system_prompt_for(30) (distinct from 60)."""
    captured = {}

    def fake_generate(topic, cache_dir=None, **kw):
        captured.update(kw)
        return BeatsScript(title="T", beats=[Beat(text="hook"), Beat(text="out")])

    monkeypatch.setattr("pipeline.script.generate_grounded_script", fake_generate)

    executors.run_script(_ctx(tmp_path, target_length=30), {})

    # 30s prompt differs from 60s (5-6 beats vs 5-8 beats)
    assert captured.get("system_prompt") == script_stage.system_prompt_for(30)
    assert "Produce 5-6 beats" in captured["system_prompt"]


# ---------------------------------------------------------------------------
# 3. _input_hash includes target_length → cache-bust on preset change
# ---------------------------------------------------------------------------

def _install_script_fake(monkeypatch):
    script = BeatsScript(title="T", beats=[Beat(text="hook"), Beat(text="out")])
    monkeypatch.setattr("pipeline.script.generate_grounded_script",
                        lambda topic, cache_dir=None, **kw: script)
    monkeypatch.setattr("pipeline.tts.synthesize",
                        lambda lines, path, **kw: (
                            Path(path).parent.mkdir(parents=True, exist_ok=True),
                            Path(path).write_bytes(b"W"),
                            [LineOffset(i, t, float(i), float(i + 1))
                             for i, t in enumerate(lines)],
                        )[-1])
    monkeypatch.setattr("pipeline.timing.transcribe_words",
                        lambda wav, fps: [WordTiming("w", 0, 5)])
    monkeypatch.setattr("pipeline.footage.fetch_footage",
                        lambda reqs, out_dir, *, fps=30, **kw: [
                            Clip(index=r.index, query=r.query,
                                 path=f"assets/f{r.index}.mp4", duration_frames=300)
                            for r in reqs])
    monkeypatch.setattr("pipeline.footage.search_pexels",
                        lambda q, key: {"videos": []})
    monkeypatch.setattr("pipeline.footage.require_env", lambda name: "K")


def test_input_hash_includes_target_length(tmp_path, monkeypatch):
    """Same session, same topic — flip ctx.target_length → script stage re-runs (cache miss)."""
    _install_script_fake(monkeypatch)
    db = tmp_path / "s.db"
    conn = store.connect(db)
    store.create_session(conn, id="s1", topic="Reefs", now="t0")

    calls = {"n": 0}

    original_script = eng_mod.EXECUTORS["script"]

    def counting_script(ctx, inputs):
        calls["n"] += 1
        return original_script(ctx, inputs)

    monkeypatch.setitem(eng_mod.EXECUTORS, "script", counting_script)

    ctx_60 = _ctx(tmp_path, target_length=60)
    eng_mod.Engine(conn, ctx_60, session_id="s1").advance("script")    # first run → n=1

    ctx_60_again = _ctx(tmp_path, target_length=60)
    eng_mod.Engine(conn, ctx_60_again, session_id="s1").advance("script")  # cache hit → n=1

    ctx_180 = _ctx(tmp_path, target_length=180)
    eng_mod.Engine(conn, ctx_180, session_id="s1").advance("script")   # cache miss → n=2

    assert calls["n"] == 2, (
        f"expected 2 script runs (60→60 cache hit, 60→180 cache miss), got {calls['n']}"
    )
    conn.close()


# ---------------------------------------------------------------------------
# 4. build_ctx threads target_length into EngineContext
# ---------------------------------------------------------------------------

def test_build_ctx_threads_target_length(tmp_path, monkeypatch):
    monkeypatch.setattr("session.job_ctx.SESSIONS_DB", tmp_path / "s.db")
    monkeypatch.setattr("session.job_ctx.REPO_ROOT", tmp_path)
    monkeypatch.setattr("session.job_ctx.ASSETS_DIR", tmp_path / "a")
    monkeypatch.setattr("session.job_ctx.RETRIEVAL_CACHE", tmp_path / "c")
    monkeypatch.setattr("session.job_ctx.TEMPLATES_DIR",
                        Path(__file__).resolve().parents[2] / "templates")

    ctx = job_ctx.build_ctx(topic="T", target_length=180)
    assert ctx.target_length == 180


def test_build_ctx_default_target_length_is_60(tmp_path, monkeypatch):
    monkeypatch.setattr("session.job_ctx.SESSIONS_DB", tmp_path / "s.db")
    monkeypatch.setattr("session.job_ctx.REPO_ROOT", tmp_path)
    monkeypatch.setattr("session.job_ctx.ASSETS_DIR", tmp_path / "a")
    monkeypatch.setattr("session.job_ctx.RETRIEVAL_CACHE", tmp_path / "c")
    monkeypatch.setattr("session.job_ctx.TEMPLATES_DIR",
                        Path(__file__).resolve().parents[2] / "templates")

    ctx = job_ctx.build_ctx(topic="T")
    assert ctx.target_length == 60


# ---------------------------------------------------------------------------
# 5. api.create stores target_length on the session row
# ---------------------------------------------------------------------------

def test_api_create_stores_target_length(tmp_path):
    ctx = _ctx(tmp_path, target_length=180)
    sess = session_api.create(tmp_path / "s.db", ctx, session_id="s1", topic="T",
                              target_length=180)
    row = store.get_session(sess.conn, "s1")
    session_api.close(sess)
    assert row["target_length"] == 180


def test_api_create_default_target_length_is_60(tmp_path):
    ctx = _ctx(tmp_path, target_length=60)
    sess = session_api.create(tmp_path / "s.db", ctx, session_id="s1", topic="T")
    row = store.get_session(sess.conn, "s1")
    session_api.close(sess)
    assert row["target_length"] == 60


# ---------------------------------------------------------------------------
# 6. start() + _resume() round-trip: create with 180, _resume builds ctx with 180
# ---------------------------------------------------------------------------

def _point_at(tmp_path, monkeypatch):
    monkeypatch.setattr("session.job_ctx.SESSIONS_DB", tmp_path / "s.db")
    monkeypatch.setattr("session.job_ctx.REPO_ROOT", tmp_path)
    monkeypatch.setattr("session.job_ctx.ASSETS_DIR", tmp_path / "a")
    monkeypatch.setattr("session.job_ctx.RETRIEVAL_CACHE", tmp_path / "c")


def _install_gate_fakes(monkeypatch):
    script = BeatsScript(
        title="Reefs",
        beats=[Beat(text="hook"), Beat(text="mid", keywords="coral reef"), Beat(text="out")],
    )
    monkeypatch.setattr("pipeline.script.generate_grounded_script",
                        lambda topic, cache_dir=None, **kw: script)
    monkeypatch.setattr("pipeline.tts.synthesize",
                        lambda lines, path, **kw: (
                            Path(path).parent.mkdir(parents=True, exist_ok=True),
                            Path(path).write_bytes(b"W"),
                            [LineOffset(i, t, float(i), float(i + 1))
                             for i, t in enumerate(lines)],
                        )[-1])
    monkeypatch.setattr("pipeline.timing.transcribe_words",
                        lambda wav, fps: [WordTiming("w", 0, 5)])
    monkeypatch.setattr("pipeline.footage.fetch_footage",
                        lambda reqs, out_dir, *, fps=30, **kw: [
                            Clip(index=r.index, query=r.query,
                                 path=f"assets/f{r.index}.mp4", duration_frames=300)
                            for r in reqs])
    monkeypatch.setattr("pipeline.footage.search_pexels",
                        lambda q, key: {"videos": []})
    monkeypatch.setattr("pipeline.footage.require_env", lambda name: "K")


def test_start_persists_target_length_and_resume_threads_it(tmp_path, monkeypatch):
    """start(topic, target_length=180) → DB row has 180; _resume builds ctx with 180."""
    _install_gate_fakes(monkeypatch)
    _point_at(tmp_path, monkeypatch)

    import session_gate as sg

    result = sg.start("Coral reefs", target_length=180)
    assert result["ok"] is True
    sid = result["sid"]

    # DB row must carry 180
    conn = store.connect(tmp_path / "s.db")
    row = store.get_session(conn, sid)
    conn.close()
    assert row["target_length"] == 180

    # _resume must build a ctx with target_length=180
    sess = sg._resume(sid)
    assert sess.engine.ctx.target_length == 180
    session_api.close(sess)


def test_start_default_target_length_is_60(tmp_path, monkeypatch):
    """start(topic) without --target-length → DB row has 60, _resume ctx has 60."""
    _install_gate_fakes(monkeypatch)
    _point_at(tmp_path, monkeypatch)

    import session_gate as sg

    result = sg.start("Coral reefs")
    sid = result["sid"]

    conn = store.connect(tmp_path / "s.db")
    row = store.get_session(conn, sid)
    conn.close()
    assert row["target_length"] == 60

    sess = sg._resume(sid)
    assert sess.engine.ctx.target_length == 60
    session_api.close(sess)
