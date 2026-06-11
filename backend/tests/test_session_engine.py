"""HITL A.1 — engine: idempotent advance (hash cache), invalidation, edit."""

from schema import Theme
from session import store, engine, executors


def _ctx(tmp_path):
    return executors.EngineContext(
        topic="T", fps=30, theme=Theme(), catalog={}, assets_dir=tmp_path,
        cache_dir=tmp_path / "c", voiceover_path=tmp_path / "v.wav",
        spec_out=tmp_path / "spec.json", sources_out=tmp_path / "sources.json")


def test_advance_is_a_noop_on_identical_inputs(tmp_path, monkeypatch):
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="s1", topic="T", now="t0")

    calls = {"n": 0}

    def fake_script(ctx, inputs):
        calls["n"] += 1
        return {"v": 1}

    # a stage with a trivial codec for the test
    monkeypatch.setitem(engine.EXECUTORS, "script", fake_script)
    monkeypatch.setitem(engine.CODECS, "script", (lambda o: o, lambda d: d))

    eng = engine.Engine(conn, _ctx(tmp_path), session_id="s1")
    eng.advance("script")
    eng.advance("script")     # identical inputs -> cache hit, executor not re-run
    assert calls["n"] == 1
    assert store.get_stage(conn, "s1", "script")["status"] == "done"
    assert store.get_session(conn, "s1")["current_stage"] == "script"
    conn.close()


def test_advance_reruns_when_an_input_changes(tmp_path, monkeypatch):
    # the complement of the cache-hit test: a changed context input (topic) must
    # bust the hash and re-run the executor (otherwise re-derive would be stale).
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="s1", topic="T", now="t0")
    calls = {"n": 0}
    monkeypatch.setitem(engine.EXECUTORS, "script", lambda ctx, inputs: calls.__setitem__("n", calls["n"] + 1) or {"v": 1})
    monkeypatch.setitem(engine.CODECS, "script", (lambda o: o, lambda d: d))

    engine.Engine(conn, _ctx(tmp_path), session_id="s1").advance("script")          # n=1
    # a fresh engine over the SAME session but a different topic -> different hash
    other = executors.EngineContext(
        topic="DIFFERENT", fps=30, theme=Theme(), catalog={}, assets_dir=tmp_path,
        cache_dir=tmp_path / "c", voiceover_path=tmp_path / "v.wav",
        spec_out=tmp_path / "spec.json", sources_out=tmp_path / "sources.json")
    engine.Engine(conn, other, session_id="s1").advance("script")                    # cache miss -> n=2
    assert calls["n"] == 2
    conn.close()


def test_advance_fails_loud_when_upstream_missing(tmp_path):
    # out-of-order advance must raise a clear error, not a cryptic codec TypeError.
    import pytest
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="s1", topic="T", now="t0")
    eng = engine.Engine(conn, _ctx(tmp_path), session_id="s1")
    with pytest.raises(RuntimeError, match="script"):
        eng.advance("voice")        # script never ran
    conn.close()


def test_invalidate_marks_downstream_stale(tmp_path):
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="s1", topic="T", now="t0")
    for st in ["script", "voice", "timing", "footage", "assemble", "render"]:
        store.upsert_stage(conn, "s1", st, status="done", input_hash="h", output_json="null", now="t0")
    eng = engine.Engine(conn, _ctx(tmp_path), session_id="s1")

    eng.invalidate("footage")     # footage edit -> assemble + render stale, NOT timing
    assert store.get_stage(conn, "s1", "assemble")["status"] == "stale"
    assert store.get_stage(conn, "s1", "render")["status"] == "stale"
    assert store.get_stage(conn, "s1", "timing")["status"] == "done"   # upstream untouched
    assert store.get_stage(conn, "s1", "voice")["status"] == "done"
    conn.close()
