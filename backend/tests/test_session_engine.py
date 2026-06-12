"""HITL A.1 — engine: idempotent advance (hash cache), invalidation, edit.
v3-M1 — deferred re-derive: edit(rederive=False) + rederive_stale()."""

from pathlib import Path

from schema import Theme
from pipeline.content import Beat, BeatsScript
from pipeline.contracts import LineOffset, WordTiming, Clip
from pipeline import validate as validate_stage
from session import store, engine, executors, api

_TEMPLATES = Path(__file__).resolve().parents[2] / "templates"


def _ctx(tmp_path):
    return executors.EngineContext(
        topic="T", fps=30, theme=Theme(), catalog={}, assets_dir=tmp_path,
        cache_dir=tmp_path / "c", voiceover_path=tmp_path / "v.wav",
        spec_out=tmp_path / "spec.json", sources_out=tmp_path / "sources.json")


# ---------------------------------------------------------------------------
# Helpers for v3-M1 deferred-rederive tests
# ---------------------------------------------------------------------------

def _fakes_with_counts(monkeypatch):
    """Install pipeline fakes AND wrap each EXECUTORS entry with a call counter.
    Returns a dict tracking how many times each stage executor was called."""
    script = BeatsScript(
        title="Reefs",
        beats=[Beat(text="hook"), Beat(text="mid", keywords="coral reef"), Beat(text="out")],
    )

    monkeypatch.setattr(
        "pipeline.script.generate_grounded_script",
        lambda topic, cache_dir=None, **kw: script,
    )
    monkeypatch.setattr(
        "pipeline.tts.synthesize",
        lambda lines, path, **kw: (
            Path(path).parent.mkdir(parents=True, exist_ok=True),
            Path(path).write_bytes(b"W"),
            [LineOffset(i, t, float(i), float(i + 1)) for i, t in enumerate(lines)],
        )[-1],
    )
    monkeypatch.setattr(
        "pipeline.timing.transcribe_words",
        lambda wav, fps: [WordTiming("w", 0, 5)],
    )
    monkeypatch.setattr(
        "pipeline.footage.fetch_footage",
        lambda reqs, out_dir, *, fps=30, **kw: [
            Clip(index=r.index, query=r.query, path=f"assets/f{r.index}.mp4", duration_frames=300)
            for r in reqs
        ],
    )
    monkeypatch.setattr("pipeline.footage.search_pexels", lambda q, key: {"videos": []})
    monkeypatch.setattr("pipeline.footage.require_env", lambda name: "K")

    # Wrap each executor in a counter. We do this AFTER the pipeline fakes are
    # installed so the real executors call the fake pipeline functions.
    calls = {st: 0 for st in ("script", "voice", "timing", "footage", "assemble")}
    for st in list(calls):
        original = engine.EXECUTORS[st]

        def make_counting(stage, orig):
            def counting(ctx, inputs):
                calls[stage] += 1
                return orig(ctx, inputs)
            return counting

        monkeypatch.setitem(engine.EXECUTORS, st, make_counting(st, original))

    return calls


def _full_ctx(tmp_path):
    return executors.EngineContext(
        topic="Reefs", fps=30, theme=Theme(),
        catalog=validate_stage.load_catalog(_TEMPLATES),
        assets_dir=tmp_path / "a", cache_dir=tmp_path / "c",
        voiceover_path=tmp_path / "a" / "v.wav",
        spec_out=tmp_path / "spec.json", sources_out=tmp_path / "src.json",
    )


def _mk_session(tmp_path, monkeypatch, sid="s1"):
    ctx = _full_ctx(tmp_path)
    return api.create(tmp_path / "s.db", ctx, session_id=sid, topic="Reefs")


def _session_all_done(tmp_path, monkeypatch):
    sess = _mk_session(tmp_path, monkeypatch)
    sess.engine.run_all()
    return sess


def _edit_beat_op(index, text):
    """Script edit op that passes verify inline (no network) — used for rederive tests."""
    return {
        "op": "edit_beat",
        "index": index,
        "text": text,
        "verify_fn": lambda claims: [{**c, "supported": True} for c in claims],
    }


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


# ---------------------------------------------------------------------------
# v3-M1: deferred re-derive — edit(rederive=False) + rederive_stale()
# ---------------------------------------------------------------------------

def test_edit_without_rederive_leaves_downstream_stale(tmp_path, monkeypatch):
    """edit(rederive=False): handler runs + downstream marked stale; NO executor re-ran."""
    calls = _fakes_with_counts(monkeypatch)
    sess = _session_all_done(tmp_path, monkeypatch)
    before = dict(calls)

    sess.engine.edit("script", _edit_beat_op(0, "Edited line."), rederive=False)

    # No new executor calls — only the script handler mutated DB directly
    assert calls == before
    # Downstream of script: voice, timing, footage, assemble all stale
    for st in ("voice", "timing", "footage", "assemble"):
        assert store.get_stage(sess.conn, sess.id, st)["status"] == "stale"


def test_rederive_stale_pays_once(tmp_path, monkeypatch):
    """rederive_stale() re-derives every stale stage exactly once and returns the list."""
    calls = _fakes_with_counts(monkeypatch)
    sess = _session_all_done(tmp_path, monkeypatch)
    sess.engine.edit("script", _edit_beat_op(0, "Edited line."), rederive=False)
    before = dict(calls)

    ran = sess.engine.rederive_stale()

    assert ran == ["voice", "timing", "footage", "assemble"]
    for st in ran:
        assert store.get_stage(sess.conn, sess.id, st)["status"] == "done"
    # Each stale stage ran exactly once
    assert calls["voice"] == before["voice"] + 1
    assert calls["timing"] == before["timing"] + 1
    assert calls["footage"] == before["footage"] + 1
    assert calls["assemble"] == before["assemble"] + 1
    # script was NOT re-run (it was already done with new output from the edit handler)
    assert calls["script"] == before["script"]


def test_edit_default_rederive_unchanged(tmp_path, monkeypatch):
    """v2 callers pass no kwarg — behavior must stay byte-identical to before."""
    calls = _fakes_with_counts(monkeypatch)
    sess = _session_all_done(tmp_path, monkeypatch)

    sess.engine.edit("script", _edit_beat_op(0, "Edited line."))

    # Default (rederive=True): downstream stages are re-derived, all end up done
    for st in ("voice", "timing", "footage", "assemble"):
        assert store.get_stage(sess.conn, sess.id, st)["status"] == "done"
