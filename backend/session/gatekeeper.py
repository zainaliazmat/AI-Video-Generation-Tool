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
    """Approve a gate and auto-start the next segment (PRD §4: no separate
    'continue' click). On a reopened gate this is Re-approve: pay the
    accumulated edits with ONE rederive, then restore downstream gates.

    Two ruled guards:
    - OV-2: a STALE gate is never the approve target — the Re-approve belongs
      to the gate that reopened; the error names it.
    - 7A: approved gate + missing next-gate row = crash mid-segment; approve
      is idempotent-forward and re-enters the segment (done stages no-op via
      the input-hash cache) instead of raising."""
    if gate not in gates.APPROVABLE:
        raise ValueError(f"gate {gate!r} is not approvable (assemble's action is Render)")
    states = store.get_gate_states(sess.conn, sess.id)
    cur = states.get(gate)
    if cur is None:
        raise ValueError(f"gate {gate!r} is not open yet")
    if cur["state"] == "stale":
        reopened = next((g for g in gates.GATE_ORDER
                         if states.get(g, {}).get("state") == "awaiting_approval"), "?")
        raise ValueError(
            f"gate {gate!r} is stale — re-approve gate {reopened!r} first")
    nxt = gates.next_gate(gate)
    if cur["state"] == "approved":
        if nxt is not None and nxt not in states:
            _run_segment(sess, nxt, on_stage)          # 7A crash recovery
            return view(sess)
        raise ValueError(f"gate {gate!r} is already approved")
    if any(s["state"] == "stale" for s in states.values()):
        _reapprove(sess, states, on_stage)
    store.upsert_gate_state(sess.conn, sess.id, gate, "approved", now=_now())
    if nxt is not None:
        nxt_state = store.get_gate_states(sess.conn, sess.id).get(nxt)
        if nxt_state is None or nxt_state["state"] != "approved":
            _run_segment(sess, nxt, on_stage)
    return view(sess)


def _reapprove(sess, states, on_stage):
    """§4.1 payment: one rederive_stale pass emitting REAL per-stage events
    (design ruling 1 — no synthetic 'rederive' card), then each stale gate
    restores to its pre-reopen truth via approved_at."""
    sess.engine.rederive_stale(on_stage)
    for g, s in states.items():
        if s["state"] != "stale":
            continue
        restored = "approved" if s["approved_at"] else "awaiting_approval"
        store.upsert_gate_state(sess.conn, sess.id, g, restored, now=_now())


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
