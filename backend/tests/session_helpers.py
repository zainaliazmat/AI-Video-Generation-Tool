"""Shared fixtures-as-functions for session engine/gatekeeper tests.

Public helpers
--------------
fakes_with_counts   -- install pipeline fakes + call-counting wrappers
mk_session          -- create a fresh session with the full engine context
session_all_done    -- create a session and run all stages to completion
edit_beat_op        -- build a script edit op that passes verify inline
started             -- mk_session + gatekeeper.start(); halted at script gate
at_assemble_gate    -- started + approve(script) + approve(voice) + approve(scenes);
                       halted at the assemble gate (Tasks 6-8 reuse this)
"""
from __future__ import annotations

from pathlib import Path

from schema import Theme
from pipeline.content import Beat, BeatsScript
from pipeline.contracts import LineOffset, WordTiming, Clip
from pipeline import validate as validate_stage
from session import engine, executors, api, gatekeeper

_TEMPLATES = Path(__file__).resolve().parents[2] / "templates"


def _full_ctx(tmp_path):
    return executors.EngineContext(
        topic="Reefs", fps=30, theme=Theme(),
        catalog=validate_stage.load_catalog(_TEMPLATES),
        assets_dir=tmp_path / "a", cache_dir=tmp_path / "c",
        voiceover_path=tmp_path / "a" / "v.wav",
        spec_out=tmp_path / "spec.json", sources_out=tmp_path / "src.json",
    )


def fakes_with_counts(monkeypatch):
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
    # search_pexels now takes orientation (merged pool calls it for portrait + unfiltered);
    # search_pexels_photos is the photo arm of the merged gate pool. Both empty here.
    monkeypatch.setattr("pipeline.footage.search_pexels",
                        lambda q, key, orientation=None: {"videos": []})
    monkeypatch.setattr("pipeline.footage.search_pexels_photos", lambda q, key: {"photos": []})
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


def mk_session(tmp_path, monkeypatch=None, sid="s1"):
    """Create a fresh session isolated under tmp_path/<sid>/ so two sessions in
    the same tmp_path do not share spec_out or the database.  monkeypatch is
    accepted but unused (fakes are installed separately via fakes_with_counts)."""
    sid_dir = tmp_path / sid
    sid_dir.mkdir(parents=True, exist_ok=True)
    ctx = _full_ctx(sid_dir)
    return api.create(sid_dir / "s.db", ctx, session_id=sid, topic="Reefs")


def session_all_done(tmp_path, monkeypatch):
    sess = mk_session(tmp_path, monkeypatch)
    sess.engine.run_all()
    return sess


def edit_beat_op(index, text):
    """Script edit op that passes verify inline (no network) — used for rederive tests."""
    return {
        "op": "edit_beat",
        "index": index,
        "text": text,
        "verify_fn": lambda claims: [{**c, "supported": True} for c in claims],
    }


def started(tmp_path, monkeypatch, sid="s1"):
    """mk_session + gatekeeper.start(); session halted at the script gate.

    Reused by Tasks 5–8: any test that needs a session at the first
    human checkpoint calls this instead of inlining the two lines."""
    sess = mk_session(tmp_path, monkeypatch, sid=sid)
    gatekeeper.start(sess)
    return sess


def at_assemble_gate(tmp_path, monkeypatch, sid="s1"):
    """started + approve(script) + approve(voice) + approve(scenes).

    Session is halted at the assemble gate (the terminal gate). Reused by
    Tasks 6–8 for tests that need a fully-approved, spec-materialized
    session ready for render or editing."""
    sess = started(tmp_path, monkeypatch, sid=sid)
    gatekeeper.approve(sess, "script")
    gatekeeper.approve(sess, "voice")
    gatekeeper.approve(sess, "scenes")
    return sess
