"""Studio v3 gatekeeper — Task 4, Task 5, and Task 6 tests."""
from __future__ import annotations

import pytest

from session import gatekeeper, store
from tests.session_helpers import (
    fakes_with_counts as _fakes,
    mk_session as _mk_session,
    started as _started,
    at_assemble_gate as _at_assemble_gate,
    edit_beat_op as _edit_beat_op,
)


# ---------------------------------------------------------------------------
# Task 4: gatekeeper.start halts at the script gate
# ---------------------------------------------------------------------------

def test_start_halts_at_script_gate(tmp_path, monkeypatch):
    calls = _fakes(monkeypatch)
    sess = _mk_session(tmp_path, monkeypatch)

    events = []
    gatekeeper.start(sess, on_stage=lambda s, st, el: events.append((s, st)))

    # script executor ran exactly once
    assert calls["script"] == 1

    # downstream stages were NOT executed
    for st in ("voice", "timing", "footage", "assemble"):
        assert store.get_stage(sess.conn, sess.id, st) is None, \
            f"stage {st!r} ran but should not have"

    # script gate is awaiting approval
    gate_states = store.get_gate_states(sess.conn, sess.id)
    assert gate_states["script"]["state"] == "awaiting_approval"

    # on_stage received exactly the running + done events for script
    assert events == [("script", "running"), ("script", "done")]


# ---------------------------------------------------------------------------
# Task 5: gatekeeper.approve — linear approvals
# ---------------------------------------------------------------------------

def test_approve_script_opens_voice_gate_without_running_anything(tmp_path, monkeypatch):
    calls = _fakes(monkeypatch)
    sess = _started(tmp_path, monkeypatch)
    before = dict(calls)
    gatekeeper.approve(sess, "script")
    g = store.get_gate_states(sess.conn, sess.id)
    assert g["script"]["state"] == "approved" and g["script"]["approved_at"]
    assert g["voice"]["state"] == "awaiting_approval"
    assert calls == before, "approving script must not run any executor (voice segment is empty)"


def test_approve_voice_runs_heavy_segment_and_halts_at_scenes(tmp_path, monkeypatch):
    calls = _fakes(monkeypatch)
    sess = _started(tmp_path, monkeypatch)
    gatekeeper.approve(sess, "script")
    events = []
    gatekeeper.approve(sess, "voice", on_stage=lambda s, st, el: events.append((s, st, el)))
    g = store.get_gate_states(sess.conn, sess.id)
    assert g["scenes"]["state"] == "awaiting_approval"
    assert store.get_stage(sess.conn, sess.id, "footage")["status"] == "done"
    # ruling 1A: assemble runs INSIDE the scenes segment — spec exists at the
    # scenes gate so the per-scene players have something to play
    assert store.get_stage(sess.conn, sess.id, "assemble")["status"] == "done"
    assert sess.engine.ctx.spec_out.exists()
    # task-card contract: running has no elapsed, done carries elapsed_s
    assert [(s, st) for s, st, _ in events] == [
        ("voice", "running"), ("voice", "done"),
        ("timing", "running"), ("timing", "done"),
        ("footage", "running"), ("footage", "done"),
        ("assemble", "running"), ("assemble", "done")]
    assert all(el is not None for s, st, el in events if st == "done")


def test_approve_scenes_opens_assemble_instantly(tmp_path, monkeypatch):
    # 1A: assemble's own segment is empty — approving scenes is a state flip
    calls = _fakes(monkeypatch)
    sess = _started(tmp_path, monkeypatch)
    gatekeeper.approve(sess, "script")
    gatekeeper.approve(sess, "voice")
    before = dict(calls)
    gatekeeper.approve(sess, "scenes")
    assert calls == before, "approving scenes must not run any executor (assemble segment is empty)"
    states = store.get_gate_states(sess.conn, sess.id)
    assert states["assemble"]["state"] == "awaiting_approval"


def test_approve_out_of_order_or_twice_rejected(tmp_path, monkeypatch):
    _fakes(monkeypatch)
    sess = _started(tmp_path, monkeypatch)
    with pytest.raises(ValueError):
        gatekeeper.approve(sess, "voice")             # not open yet
    gatekeeper.approve(sess, "script")
    with pytest.raises(ValueError):
        gatekeeper.approve(sess, "script")            # already approved, next gate open
    with pytest.raises(ValueError):
        gatekeeper.approve(sess, "assemble")          # terminal, not approvable


def test_approve_stale_gate_rejected_names_the_reopened_gate(tmp_path, monkeypatch):
    # ruling OV-2: a stale gate is never the approve target — Re-approve
    # belongs to the gate that reopened, or rederive pays the wrong bill.
    # NOTE: Task 6's edit tests cover the real gatekeeper.edit() reopen path;
    # here we write the same store state directly since gatekeeper.edit arrives
    # in Task 6.
    _fakes(monkeypatch)
    sess = _at_assemble_gate(tmp_path, monkeypatch)
    # Simulate the state that gatekeeper.edit("script", ...) will produce in Task 6:
    # script reopens to awaiting_approval, downstream gates flip to stale.
    store.upsert_gate_state(sess.conn, sess.id, "script", "awaiting_approval", now="reopen")
    store.upsert_gate_state(sess.conn, sess.id, "voice", "stale", now="reopen")
    store.upsert_gate_state(sess.conn, sess.id, "scenes", "stale", now="reopen")
    store.upsert_gate_state(sess.conn, sess.id, "assemble", "stale", now="reopen")
    with pytest.raises(ValueError, match=r"re-approve gate 'script' first"):
        gatekeeper.approve(sess, "scenes")            # stale — not approvable


def test_approve_resumes_after_crash_mid_segment(tmp_path, monkeypatch):
    # ruling 7A: gate approved + next gate row missing = crashed mid-segment;
    # approve is idempotent-forward (done stages no-op via the hash cache)
    calls = _fakes(monkeypatch)
    sess = _started(tmp_path, monkeypatch)
    gatekeeper.approve(sess, "script")
    # simulate the crash: approve("voice") recorded the approval and ran the
    # voice stage, then the process died before the scenes gate row was written
    store.upsert_gate_state(sess.conn, sess.id, "voice", "approved", now="t-crash")
    sess.engine.advance("voice")
    assert "scenes" not in store.get_gate_states(sess.conn, sess.id)
    gatekeeper.approve(sess, "voice")                 # resumes, does NOT raise
    g = store.get_gate_states(sess.conn, sess.id)
    assert g["scenes"]["state"] == "awaiting_approval"
    assert calls["voice"] == 1                        # cache hit — not re-run


# ---------------------------------------------------------------------------
# Task 6: gatekeeper.edit — §4.1 reopen + Re-approve + deferred voice change
# ---------------------------------------------------------------------------

def test_gated_edit_reopens_and_defers(tmp_path, monkeypatch):
    calls = _fakes(monkeypatch)
    sess = _at_assemble_gate(tmp_path, monkeypatch)    # 3 approvals done
    before = dict(calls)
    gatekeeper.edit(sess, "script", _edit_beat_op(0, "Edited line."))
    g = store.get_gate_states(sess.conn, sess.id)
    assert g["script"]["state"] == "awaiting_approval"      # reopened
    assert g["voice"]["state"] == "stale" and g["voice"]["approved_at"]
    assert g["scenes"]["state"] == "stale"
    assert g["assemble"]["state"] == "stale" and not g["assemble"]["approved_at"]
    assert calls == before                                   # nothing re-derived


def test_second_edit_accumulates_without_confirm_state_change(tmp_path, monkeypatch):
    calls = _fakes(monkeypatch)
    sess = _at_assemble_gate(tmp_path, monkeypatch)
    gatekeeper.edit(sess, "script", _edit_beat_op(0, "Edit one."))
    snapshot = store.get_gate_states(sess.conn, sess.id)
    gatekeeper.edit(sess, "script", _edit_beat_op(1, "Edit two."))
    assert {k: v["state"] for k, v in store.get_gate_states(sess.conn, sess.id).items()} \
        == {k: v["state"] for k, v in snapshot.items()}


def test_reapprove_pays_once_and_restores(tmp_path, monkeypatch):
    calls = _fakes(monkeypatch)
    sess = _at_assemble_gate(tmp_path, monkeypatch)
    gatekeeper.edit(sess, "script", _edit_beat_op(0, "Edit one."))
    gatekeeper.edit(sess, "script", _edit_beat_op(1, "Edit two."))
    before = dict(calls)
    gatekeeper.approve(sess, "script")                       # Re-approve
    g = store.get_gate_states(sess.conn, sess.id)
    assert g["script"]["state"] == "approved"
    assert g["voice"]["state"] == "approved"                 # prior approval stands
    assert g["scenes"]["state"] == "approved"
    assert g["assemble"]["state"] == "awaiting_approval"     # frontier restored
    assert calls["voice"] == before["voice"] + 1             # ONE payment for two edits


def test_frontier_edit_stays_v2(tmp_path, monkeypatch):
    calls = _fakes(monkeypatch)
    sess = _started(tmp_path, monkeypatch)               # script gate awaiting
    gatekeeper.edit(sess, "script", _edit_beat_op(0, "Pre-approval edit."))
    g = store.get_gate_states(sess.conn, sess.id)
    assert g["script"]["state"] == "awaiting_approval"  # no reopen drama
    assert store.get_stage(sess.conn, sess.id, "voice") is None


def test_empty_blast_radius_edit_skips_reopen(tmp_path, monkeypatch):
    # ruling OV-11: script approved, voice gate awaiting (empty segment,
    # nothing downstream RAN) — the edit is free, no reopen, no Re-approve
    calls = _fakes(monkeypatch)
    sess = _started(tmp_path, monkeypatch)
    gatekeeper.approve(sess, "script")                   # voice awaiting
    gatekeeper.edit(sess, "script", _edit_beat_op(0, "Still free."))
    g = store.get_gate_states(sess.conn, sess.id)
    assert g["script"]["state"] == "approved"            # NOT reopened
    assert g["voice"]["state"] == "awaiting_approval"    # NOT stale


def test_scenes_frontier_edit_is_instant(tmp_path, monkeypatch):
    # ruled: "scene-gate edits are instant via the frontier path" — at the
    # AWAITING scenes gate (never approved), a timing edit re-derives the
    # already-ran downstream (footage, assemble) immediately and
    # re-materializes spec.json; no reopen, no deferral, gate still awaiting
    calls = _fakes(monkeypatch)
    sess = _started(tmp_path, monkeypatch)
    gatekeeper.approve(sess, "script")
    gatekeeper.approve(sess, "voice")            # heavy segment ran; scenes awaiting
    before = dict(calls)
    # timing fake returns [WordTiming("w", 0, 5)]; index 0 is in-range
    gatekeeper.edit(sess, "timing", {"op": "fix_word", "index": 0, "text": "kilometres"})
    g = store.get_gate_states(sess.conn, sess.id)
    assert g["scenes"]["state"] == "awaiting_approval"          # no reopen drama
    assert store.get_stage(sess.conn, sess.id, "assemble")["status"] == "done"
    assert calls["assemble"] == before["assemble"] + 1          # re-derived immediately
    assert sess.engine.ctx.spec_out.exists()                    # spec rematerialized


def test_edit_at_stale_gate_rejected(tmp_path, monkeypatch):
    # M6 contract: stale gates are view-only; backend backstops the UI
    _fakes(monkeypatch)
    sess = _at_assemble_gate(tmp_path, monkeypatch)
    # editing script at the approved gate reopens it → scenes goes stale
    gatekeeper.edit(sess, "script", _edit_beat_op(0, "Reopen script."))
    g = store.get_gate_states(sess.conn, sess.id)
    assert g["scenes"]["state"] == "stale"                      # scenes is stale now
    with pytest.raises(ValueError, match=r"re-approve gate 'script'"):
        # timing belongs to scenes gate, which is stale → rejected
        gatekeeper.edit(sess, "timing", {"op": "fix_word", "index": 0, "text": "x"})


def test_set_voice_defers_like_an_edit(tmp_path, monkeypatch):
    calls = _fakes(monkeypatch)
    sess = _at_assemble_gate(tmp_path, monkeypatch)
    # Prevent set_voice from writing to the real repo filesystem
    write_voice_calls = []
    monkeypatch.setattr(
        "pipeline.projects.write_voice",
        lambda repo_root, sid, *, voice, speed: write_voice_calls.append((repo_root, sid, voice, speed)),
    )
    before = dict(calls)
    gatekeeper.set_voice(sess, voice="af_bella", speed=1.1)
    g = store.get_gate_states(sess.conn, sess.id)
    assert g["voice"]["state"] == "awaiting_approval"
    assert g["scenes"]["state"] == "stale"
    assert store.get_stage(sess.conn, sess.id, "voice")["status"] == "stale"
    assert calls == before
    # write_voice was called with the right args
    assert len(write_voice_calls) == 1
    _repo_root, _sid, voice_arg, speed_arg = write_voice_calls[0]
    assert voice_arg == "af_bella" and speed_arg == 1.1
