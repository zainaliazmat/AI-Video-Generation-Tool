"""Programmatic Session API: create / get / advance / run_all / edit / regenerate /
resume / close. A thin handle over (sqlite connection + engine). The frontend
harness (A.6) and the preview API will call these; A.1 exercises them in tests."""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass

# alias the engine module so it doesn't clash with the Session.engine field below
from session import store, stages
from session import engine as _engine
from session import gatekeeper


@dataclass
class Session:
    conn: sqlite3.Connection
    engine: _engine.Engine
    id: str


def create(db_path, ctx, *, session_id, topic, target_length: int = 60) -> Session:
    conn = store.connect(db_path)
    if store.get_session(conn, session_id) is None:
        store.create_session(conn, id=session_id, topic=topic, now="created",
                             target_length=target_length)
    return Session(conn=conn, engine=_engine.Engine(conn, ctx, session_id=session_id), id=session_id)


def resume(db_path, ctx, *, session_id) -> Session:
    conn = store.connect(db_path)
    if store.get_session(conn, session_id) is None:
        raise KeyError(f"no session {session_id!r} to resume")
    return Session(conn=conn, engine=_engine.Engine(conn, ctx, session_id=session_id), id=session_id)


def get(sess: Session):
    return store.get_session(sess.conn, sess.id)


def advance(sess: Session, stage):
    return sess.engine.advance(stage)


def run_all(sess: Session):
    return sess.engine.run_all()


def edit(sess: Session, stage, op):
    # OV-1 seam: gated sessions route through gatekeeper; ungated (v2/autopilot) are byte-identical.
    if store.get_gate_states(sess.conn, sess.id):
        return gatekeeper.edit(sess, stage, op)
    return sess.engine.edit(stage, op)


def regenerate(sess: Session, stage):
    """Force a fresh run of a stage (ignore the input-hash cache) + re-derive down.
    Requires this stage's upstream deps to be `done` (advance fails loud otherwise).

    OV-1 seam: gated sessions route through gatekeeper.regenerate (same pattern as
    edit); ungated (v2/autopilot) continue with the byte-identical body below."""
    if store.get_gate_states(sess.conn, sess.id):
        return gatekeeper.regenerate(sess, stage)
    existing_row = store.get_stage(sess.conn, sess.id, stage)
    existing_output = existing_row["output_json"] if existing_row else None
    store.upsert_stage(sess.conn, sess.id, stage, status="stale", input_hash=None,
                       output_json=existing_output, now="regen")
    # mark downstream stale first (mirrors engine.edit) so an interrupted re-derive
    # leaves a recoverable state rather than a half-done/half-fresh mix.
    sess.engine.invalidate(stage)
    sess.engine.advance(stage)
    for st in stages.downstream(stage):
        if st != "render":
            sess.engine.advance(st)
    sess.engine.materialize_spec()


def media_provenance(sess: Session):
    """Per-scene media provenance for the A.6 badge UI:
    {scene_index: {source, query, rank, pexels_id, pexels_url}}."""
    return store.get_media_provenance(sess.conn, sess.id)


def close(sess: Session):
    sess.conn.close()


# ── v3-M1: gate wrappers (thin delegation to gatekeeper) ────────────────────

def gate_start(sess: Session, *, auto_run=False, on_stage=None):
    return gatekeeper.start(sess, auto_run=auto_run, on_stage=on_stage)

def gate_approve(sess: Session, gate, *, on_stage=None):
    return gatekeeper.approve(sess, gate, on_stage=on_stage)

def gate_edit(sess: Session, stage, op):
    return gatekeeper.edit(sess, stage, op)

def gate_set_voice(sess: Session, *, voice, speed=1.0):
    return gatekeeper.set_voice(sess, voice=voice, speed=speed)

def gate_view(sess: Session):
    return gatekeeper.view(sess)

def gate_set_auto_run(sess: Session, flag: bool):
    return gatekeeper.set_auto_run_mode(sess, flag)

def gate_preview_reopen(sess: Session, gate):
    return gatekeeper.preview_reopen(sess, gate)
