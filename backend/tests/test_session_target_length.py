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


# ---------------------------------------------------------------------------
# 3b. No-bust hash: _input_hash at target_length=60 == pre-M2 hash (key absent)
# ---------------------------------------------------------------------------

def test_input_hash_at_default_60_equals_pre_m2_hash(tmp_path):
    """Hash at target_length=60 must equal the hash that would have been computed
    before M2 (no target_length key in the payload) — so every pre-M2 stage row
    cached under default 60 still hits after the upgrade."""
    import hashlib as _hashlib
    import json as _json
    from session import engine as eng_mod

    db = tmp_path / "s.db"
    conn = store.connect(db)
    store.create_session(conn, id="s-nobust", topic="Whales", now="t0")

    ctx_60 = _ctx(tmp_path, target_length=60)
    eng = eng_mod.Engine(conn, ctx_60, session_id="s-nobust")

    # Call _input_hash with empty inputs (script has no deps)
    h_60 = eng._input_hash("script", {})

    # Reconstruct the pre-M2 payload (no target_length key) and hash it directly
    pre_m2_payload = {"stage": "script", "topic": ctx_60.topic, "fps": ctx_60.fps,
                      "inputs": {}}
    pre_m2_blob = _json.dumps(pre_m2_payload, sort_keys=True)
    h_pre_m2 = _hashlib.sha256(pre_m2_blob.encode("utf-8")).hexdigest()

    assert h_60 == h_pre_m2, (
        "target_length=60 must produce the same hash as a pre-M2 payload "
        "(no target_length key) so resumed sessions don't silently re-derive"
    )
    conn.close()


# ---------------------------------------------------------------------------
# 2b. v2 CLIs thread stored preset — session_timing.read uses target_length=180
# ---------------------------------------------------------------------------

def test_v2_cli_timing_threads_stored_target_length(tmp_path, monkeypatch):
    """Create a 180 session in the DB, then call session_timing.read; the build_ctx
    invocation inside the CLI must receive target_length=180 (not the default 60)."""
    monkeypatch.setattr("session.job_ctx.SESSIONS_DB", tmp_path / "s.db")
    monkeypatch.setattr("session.job_ctx.REPO_ROOT", tmp_path)
    monkeypatch.setattr("session.job_ctx.ASSETS_DIR", tmp_path / "a")
    monkeypatch.setattr("session.job_ctx.RETRIEVAL_CACHE", tmp_path / "c")
    monkeypatch.setattr("session.job_ctx.TEMPLATES_DIR",
                        Path(__file__).resolve().parents[2] / "templates")

    # Seed the DB with a 180-session row
    db = tmp_path / "s.db"
    conn = store.connect(db)
    store.create_session(conn, id="s-tl180", topic="Oceans", now="t0",
                         target_length=180)
    conn.close()

    # Capture the target_length kwarg that session_timing.read passes to build_ctx
    captured: dict = {}
    import session.job_ctx as _jc
    _orig_build_ctx = _jc.build_ctx

    def spy_build_ctx(**kw):
        captured.update(kw)
        return _orig_build_ctx(**kw)

    monkeypatch.setattr("session.job_ctx.build_ctx", spy_build_ctx)
    # Also patch session_timing's local reference (imported at module level)
    import session_timing as st_mod
    monkeypatch.setattr(st_mod.job_ctx, "build_ctx", spy_build_ctx)

    # Stub api.resume and api.close so no real DB engine work is needed
    class _FakeEng:
        def _load_output(self, stage):
            return [] if stage == "timing" else []

    class _FakeSess:
        engine = _FakeEng()

    monkeypatch.setattr(st_mod.api, "resume",
                        lambda db, ctx, session_id: _FakeSess())
    monkeypatch.setattr(st_mod.api, "close", lambda sess: None)

    result = st_mod.read("s-tl180")

    assert result["ok"] is True
    assert captured.get("target_length") == 180, (
        f"session_timing.read must pass target_length=180 from the DB row; "
        f"got {captured.get('target_length')!r}"
    )
