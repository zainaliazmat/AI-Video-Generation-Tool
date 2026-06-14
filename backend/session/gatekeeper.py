"""Studio v3 gate state machine (PRD §6.1, §4.1) — thin orchestration over the
gate-blind engine. Owns WHEN segments run; never touches HOW stages execute.
on_stage(stage, state, elapsed_s) feeds the interstitial task card through the
PROGRESS→SSE channel (session_gate.py / approve route)."""
from __future__ import annotations

import time

from session import gates, store
from session.engine import _now


def _reject_stale(states, gate, *, suffix=""):
    """OV-2 / view-only guard: a stale gate is never an action target — the
    action belongs to the reopened (awaiting_approval) gate; the error names it.
    RuntimeError on the unreachable no-awaiting-gate state (DB inconsistency)."""
    reopened = next(
        (g for g in gates.GATE_ORDER
         if states.get(g, {}).get("state") == "awaiting_approval"), None)
    if reopened is None:
        raise RuntimeError(
            f"gate {gate!r} is stale but no gate is awaiting_approval "
            f"in {sorted(states)!r} — gate-state invariant violated")
    raise ValueError(
        f"gate {gate!r} is stale{suffix} — re-approve gate {reopened!r} first")


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
        _reject_stale(states, gate)
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
        # Re-read: _reapprove may have restored gate rows since the snapshot.
        nxt_state = store.get_gate_states(sess.conn, sess.id).get(nxt)
        if nxt_state is None or nxt_state["state"] != "approved":
            _run_segment(sess, nxt, on_stage)
    # Auto-run cascade (PRD §4): if the flag is on, the next approvable gate is
    # not yet approved, and there IS a next approvable gate — recurse to drive it.
    if nxt in gates.APPROVABLE:
        row = store.get_session(sess.conn, sess.id)
        if row["auto_run"]:
            nxt_cur = store.get_gate_states(sess.conn, sess.id).get(nxt, {})
            if nxt_cur.get("state") != "approved":
                return approve(sess, nxt, on_stage=on_stage)
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


def preview_reopen(sess, gate):
    """Read-only blast radius for the §4.1 amber sheet: which stages would
    re-run and which gates go stale. Scene-level pin survival detail lands in
    M5 (overrides tables know the pins); M6 composes the sheet copy."""
    from session import stages as stages_mod
    owned = [s for s, g in gates.GATE_FOR_STAGE.items() if g == gate]
    down = set()
    for s in owned:
        down.update(d for d in stages_mod.downstream(s) if d != "render")
    ran = [s for s in stages_mod.STAGE_ORDER
           if s in down and store.get_stage(sess.conn, sess.id, s) is not None]
    states = store.get_gate_states(sess.conn, sess.id)
    return {"gate": gate,
            "reruns": ran,
            "staleGates": [g for g in gates.downstream_gates(gate) if g in states]}


def edit(sess, stage, op):
    """A gated edit (§4.1), routed by the OWNING gate's state:

    - gate row missing, stage ran (1A corollary — e.g. assemble ran inside the
      scenes segment before its own gate row exists): plain v2 edit — downstream
      of such a stage is empty-or-render, so the default path just re-applies
      and re-materializes.
    - gate STALE: rejected — stale gates are view-only (M6 contract); the
      Re-approve belongs to the reopened gate, the error names it.
    - gate APPROVED or REOPENED (awaiting_approval with an approved_at stamp):
      non-empty blast radius ⇒ §4.1 reopen/accumulate — apply WITHOUT
      re-deriving; Re-approve pays once. Empty blast radius (ruling OV-11:
      nothing downstream ever ran) ⇒ the edit is free, no reopen.
    - gate at a true FRONTIER (awaiting_approval, never approved): instant —
      apply, then re-derive ONLY the stages that already ran (ruling: scene-gate
      edits are instant; rederive_stale skips never-run stages so the pipeline
      never advances past the gate).

    Voice edits route to set_voice (ruling OV-13 — voice is regenerate-shaped,
    engine.edit has no voice handler). The blast-radius sheet's Confirm is what
    calls this; Cancel never reaches the backend."""
    if stage == "voice":
        return set_voice(sess, voice=op["voice"], speed=op.get("speed", 1.0))
    gate = gates.GATE_FOR_STAGE[stage]
    states = store.get_gate_states(sess.conn, sess.id)
    row = states.get(gate)
    if row is None:
        # 1A corollary: a stage may have run inside an earlier segment before
        # its own gate row exists (assemble at the scenes gate) — that's a
        # frontier edit, not an error
        if store.get_stage(sess.conn, sess.id, stage) is None:
            raise ValueError(f"gate {gate!r} has not been reached; nothing to edit")
        sess.engine.edit(stage, op)
        return view(sess)
    if row["state"] == "stale":
        _reject_stale(states, gate, suffix=" (view-only)")
    if row["state"] == "approved" or row["approved_at"]:
        # approved, or reopened (awaiting with a stamp): §4.1 territory
        if preview_reopen(sess, gate)["reruns"]:
            sess.engine.edit(stage, op, rederive=False)   # reopen/accumulate: defer
            _reopen(sess, gate)
            return view(sess)
        sess.engine.edit(stage, op, rederive=False)       # OV-11: free, no reopen
        return view(sess)
    # true frontier: instant — re-derive only what already ran (never advances
    # past the gate: rederive_stale skips stages with no row)
    sess.engine.edit(stage, op, rederive=False)
    sess.engine.rederive_stale()
    if stage == "assemble":
        # assemble has no non-render downstream, so nothing goes stale and
        # rederive_stale can't re-materialize — but the edit changed the
        # assemble output; spec.json must follow immediately
        sess.engine.materialize_spec()
    return view(sess)


def set_voice(sess, *, voice, speed=1.0):
    """Deferred voice/speed change at a reopened Voice gate. Voice has no edit
    handler (it's regenerate-shaped) — mirror api.regenerate's first half
    (backend/session/api.py:50-65) without the re-derive."""
    states = store.get_gate_states(sess.conn, sess.id)
    row = states.get("voice")
    if row is not None and row["state"] == "stale":
        _reject_stale(states, "voice", suffix=" (view-only)")
    from pipeline import projects as projects_mod
    from session import job_ctx
    projects_mod.write_voice(job_ctx.REPO_ROOT, sess.id, voice=voice, speed=speed)
    row = store.get_stage(sess.conn, sess.id, "voice")
    store.upsert_stage(sess.conn, sess.id, "voice", status="stale", input_hash=None,
                       output_json=row["output_json"] if row else None, now=_now())
    sess.engine.invalidate("voice")
    _reopen(sess, "voice")
    return view(sess)


def regenerate(sess, stage):
    """Gated regenerate (script gate's primary action): re-run the stage NOW so
    the gate page shows fresh output, then route downstream by the same §4.1
    dispatch as edit():

    - At a true FRONTIER (awaiting_approval, never approved): advance the stage
      NOW, then instantly re-derive only the stages that already ran
      (rederive_stale skips never-run stages, so the pipeline never advances past
      the gate).
    - At an APPROVED or REOPENED gate: advance the stage NOW, then reopen the
      gate (§4.1) — downstream defers to Re-approve.
    - STALE gate: view-only (M6 contract); names the awaiting gate to Re-approve.
    - Gate row missing (stage has never been reached): raises ValueError.

    Mirrors api.regenerate's stale-marking idiom exactly: upsert status=stale +
    input_hash=None THEN engine.invalidate THEN engine.advance. The None hash
    ensures advance() re-runs even when the inputs haven't changed."""
    gate = gates.GATE_FOR_STAGE[stage]
    states = store.get_gate_states(sess.conn, sess.id)
    row = states.get(gate)
    if row is None:
        raise ValueError(f"gate {gate!r} has not been reached; nothing to regenerate")
    if row["state"] == "stale":
        _reject_stale(states, gate, suffix=" (view-only)")
    # stale-mark the stage row BEFORE invalidate+advance (donor pattern from api.regenerate)
    stage_row = store.get_stage(sess.conn, sess.id, stage)
    store.upsert_stage(sess.conn, sess.id, stage, status="stale", input_hash=None,
                       output_json=stage_row["output_json"] if stage_row else None,
                       now=_now())
    sess.engine.invalidate(stage)
    sess.engine.advance(stage)    # the fresh output, NOW (input_hash=None forces re-run)
    if row["state"] == "approved" or row["approved_at"]:
        # approved or reopened (awaiting with a stamp): §4.1 territory
        if preview_reopen(sess, gate)["reruns"]:
            _reopen(sess, gate)   # downstream defers to Re-approve
            return view(sess)
        return view(sess)         # OV-11: nothing downstream ran — free, no reopen
    # true frontier: instant re-derive for stages that already ran
    sess.engine.rederive_stale()
    if stage == "assemble":
        # assemble has no non-render downstream: nothing goes stale, so
        # rederive_stale can't re-materialize — but the regenerated output
        # must reach spec.json immediately (same guard as edit()'s frontier)
        sess.engine.materialize_spec()
    return view(sess)


def _reopen(sess, gate):
    store.upsert_gate_state(sess.conn, sess.id, gate, "awaiting_approval", now=_now())
    states = store.get_gate_states(sess.conn, sess.id)
    for g in gates.downstream_gates(gate):
        if g in states:                             # only gates already reached
            store.upsert_gate_state(sess.conn, sess.id, g, "stale", now=_now())


def set_auto_run_mode(sess, flag: bool):
    """Toggle auto-run mid-flow (PRD §4). Persists immediately; the cascade
    takes effect on the NEXT approve() call (mid-flow toggle does not
    retroactively cascade gates already approved)."""
    store.set_auto_run(sess.conn, sess.id, flag, now=_now())


def start(sess, *, auto_run=False, on_stage=None):
    """Entry from Generate: run to the script gate — or straight through on
    auto-run (PRD §4: approve everything with defaults; same code path)."""
    set_auto_run_mode(sess, auto_run)
    _run_segment(sess, "script", on_stage)
    if auto_run:
        approve(sess, "script", on_stage=on_stage)
    return view(sess)


def view(sess):
    row = store.get_session(sess.conn, sess.id)
    return {"gates": store.get_gate_states(sess.conn, sess.id),
            "autoRun": bool(row["auto_run"]),
            "currentStage": row["current_stage"]}
