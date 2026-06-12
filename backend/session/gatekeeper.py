"""Studio v3 gate state machine (PRD §6.1, §4.1) — thin orchestration over the
gate-blind engine. Owns WHEN segments run; never touches HOW stages execute.
on_stage(stage, state, elapsed_s) feeds the interstitial task card through the
PROGRESS→SSE channel (session_gate.py / approve route)."""
from __future__ import annotations

import time

from session import gates, store
from session.engine import _now


def _emit(on_stage, stage, state, t0=None):
    if on_stage is None:
        return
    elapsed = round(time.monotonic() - t0, 1) if t0 is not None else None
    on_stage(stage, state, elapsed)


def _run_segment(sess, gate, on_stage=None):
    """Run the stages that precede `gate`, then open it (awaiting_approval).

    When the segment includes the assemble stage, also materialize spec.json
    so the per-scene player has a spec to read when the gate opens (ruling 1A).
    """
    for stage in gates.GATE_SEGMENTS[gate]:
        t0 = time.monotonic()
        _emit(on_stage, stage, "running")
        sess.engine.advance(stage)
        _emit(on_stage, stage, "done", t0)
    if "assemble" in gates.GATE_SEGMENTS[gate]:
        sess.engine.materialize_spec()   # spec.json must exist when scenes opens (1A)
    store.upsert_gate_state(sess.conn, sess.id, gate, "awaiting_approval", now=_now())


def approve(sess, gate, *, on_stage=None):
    """Approve a gate: run the next gate's segment (if any), then open that gate.

    Task 5 — not implemented yet; stubbed so auto_run=True in start() is honest."""
    raise NotImplementedError("approve() arrives in Task 5")


def start(sess, *, auto_run=False, on_stage=None):
    """Entry from Generate: run to the script gate — or straight through on
    auto-run (PRD §4: approve everything with defaults; same code path)."""
    store.set_auto_run(sess.conn, sess.id, auto_run, now=_now())
    _run_segment(sess, "script", on_stage)
    if auto_run:
        for gate in gates.APPROVABLE:
            approve(sess, gate, on_stage=on_stage)
    return view(sess)


def view(sess):
    row = store.get_session(sess.conn, sess.id)
    return {"gates": store.get_gate_states(sess.conn, sess.id),
            "autoRun": bool(row["auto_run"]),
            "currentStage": row["current_stage"]}
