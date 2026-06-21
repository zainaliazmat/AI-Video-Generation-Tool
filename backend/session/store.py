"""SQLite persistence for HITL sessions (stdlib sqlite3, local-first, single-user).

Holds the session document: one `sessions` row, one `stages` row per pipeline
stage (status + input_hash + serialized output), and the per-scene footage
candidate pool. Binaries (audio, clips) stay on disk and are referenced by path;
spec.json stays on disk for the renderer (the renderer never reads this DB).
"""
from __future__ import annotations

import json as _json
import sqlite3
from pathlib import Path

_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  topic         TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  current_stage TEXT,
  spec_path     TEXT
);
CREATE TABLE IF NOT EXISTS stages (
  session_id  TEXT NOT NULL,
  stage       TEXT NOT NULL,
  status      TEXT NOT NULL,
  input_hash  TEXT,
  output_json TEXT,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (session_id, stage)
);
CREATE TABLE IF NOT EXISTS footage_candidates (
  session_id      TEXT NOT NULL,
  scene_index     INTEGER NOT NULL,
  rank            INTEGER NOT NULL,
  query           TEXT NOT NULL,
  clip_path       TEXT,
  duration_frames INTEGER,
  thumb_url       TEXT,
  selected        INTEGER NOT NULL DEFAULT 0,
  kind            TEXT NOT NULL DEFAULT 'video',  -- 'video' | 'image' (photo pool source)
  source          TEXT,                           -- 'portrait' | 'unfiltered' | 'photo' | 're_query'
  PRIMARY KEY (session_id, scene_index, rank)
);
CREATE TABLE IF NOT EXISTS media_provenance (
  session_id  TEXT    NOT NULL,
  scene_index INTEGER NOT NULL,
  source      TEXT    NOT NULL,
  query       TEXT,
  rank        INTEGER,
  pexels_id   INTEGER,
  pexels_url  TEXT,
  PRIMARY KEY (session_id, scene_index)
);
CREATE TABLE IF NOT EXISTS spec_patches (
  session_id  TEXT    NOT NULL,
  seq         INTEGER NOT NULL,
  kind        TEXT    NOT NULL DEFAULT 'patch',  -- 'patch' | 'revert'
  patch_json  TEXT    NOT NULL,                  -- the ops that were applied
  diff_json   TEXT    NOT NULL,                  -- [{path,before,after}] at apply time
  reverted    INTEGER NOT NULL DEFAULT 0,        -- set when a later revert undid this entry
  reverts_seq INTEGER,                           -- kind='revert': which seq it undid
  created_at  TEXT    NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE TABLE IF NOT EXISTS gates (
  session_id  TEXT NOT NULL,
  gate        TEXT NOT NULL,
  state       TEXT NOT NULL,   -- awaiting_approval | approved | stale (PRD §6.1)
  approved_at TEXT,            -- first-approval stamp; survives stale flips (§4.1 restore)
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (session_id, gate)
);
CREATE TABLE IF NOT EXISTS template_overrides (
  session_id  TEXT    NOT NULL,
  scene_index INTEGER NOT NULL,
  value       TEXT    NOT NULL,  -- JSON
  source      TEXT    NOT NULL CHECK(source IN ('auto','pinned')),
  picked_rank INTEGER,
  updated_at  TEXT    NOT NULL,
  PRIMARY KEY (session_id, scene_index)
);
CREATE TABLE IF NOT EXISTS background_overrides (
  session_id  TEXT    NOT NULL,
  scene_index INTEGER NOT NULL,
  value       TEXT    NOT NULL,  -- JSON
  source      TEXT    NOT NULL CHECK(source IN ('auto','pinned')),
  picked_rank INTEGER,
  updated_at  TEXT    NOT NULL,
  PRIMARY KEY (session_id, scene_index)
);
CREATE TABLE IF NOT EXISTS pick_log (
  session_id  TEXT    NOT NULL,
  seq         INTEGER NOT NULL,
  scene_index INTEGER NOT NULL,
  kind        TEXT    NOT NULL CHECK(kind IN ('footage','background')),
  query       TEXT,
  auto_rank   INTEGER,
  human_rank  INTEGER,
  ts          TEXT    NOT NULL,
  PRIMARY KEY (session_id, seq)
);
"""


def _migrate(conn) -> None:
    """Column additions for DBs created before v3. CREATE TABLE IF NOT EXISTS
    can't add columns, so each new sessions column gets a guarded ALTER here."""
    cols = {r[1] for r in conn.execute("PRAGMA table_info(sessions)")}
    if "auto_run" not in cols:
        conn.execute(
            "ALTER TABLE sessions ADD COLUMN auto_run INTEGER NOT NULL DEFAULT 0"
        )
        conn.commit()
    if "target_length" not in cols:
        conn.execute(
            "ALTER TABLE sessions ADD COLUMN target_length INTEGER NOT NULL DEFAULT 60"
        )
        conn.commit()
    if "prefs_override" not in cols:
        # Per-video script-style override (JSON string) layered over the global
        # script_prefs.json. NULL/absent → no override, byte-identical to today.
        conn.execute("ALTER TABLE sessions ADD COLUMN prefs_override TEXT")
        conn.commit()

    # footage_candidates: kind/source for the merged gate pool (portrait video +
    # unfiltered video + photos). Pre-overhaul DBs created these rows video-only.
    fc_cols = {r[1] for r in conn.execute("PRAGMA table_info(footage_candidates)")}
    if "kind" not in fc_cols:
        conn.execute("ALTER TABLE footage_candidates ADD COLUMN kind TEXT NOT NULL DEFAULT 'video'")
        conn.commit()
    if "source" not in fc_cols:
        conn.execute("ALTER TABLE footage_candidates ADD COLUMN source TEXT")
        conn.commit()


def connect(db_path) -> sqlite3.Connection:
    """Open (creating parent dirs) and ensure the schema. Idempotent."""
    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.executescript(_SCHEMA)
    conn.commit()
    _migrate(conn)
    return conn


def create_session(conn, *, id, topic, now, spec_path=None, current_stage=None,
                   target_length: int = 60, prefs_override=None) -> None:
    conn.execute(
        "INSERT INTO sessions"
        " (id, topic, created_at, updated_at, current_stage, spec_path, target_length,"
        "  prefs_override)"
        " VALUES (?,?,?,?,?,?,?,?)",
        (id, topic, now, now, current_stage, spec_path, target_length, prefs_override),
    )
    conn.commit()


def get_session(conn, session_id):
    return conn.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone()


def get_prefs_override(conn, session_id):
    """Return the session's per-video prefs override as a JSON string, or None."""
    row = get_session(conn, session_id)
    if row is None:
        return None
    keys = row.keys() if hasattr(row, "keys") else []
    return row["prefs_override"] if "prefs_override" in keys else None


def update_session(conn, session_id, *, now, **fields) -> None:
    if not fields:
        conn.execute("UPDATE sessions SET updated_at=? WHERE id=?", (now, session_id))
        conn.commit()
        return
    cols = ", ".join(f"{k}=?" for k in fields) + ", updated_at=?"
    conn.execute(f"UPDATE sessions SET {cols} WHERE id=?",
                 (*fields.values(), now, session_id))
    conn.commit()


def upsert_stage(conn, session_id, stage, *, status, now, input_hash=None, output_json=None) -> None:
    conn.execute(
        "INSERT INTO stages (session_id, stage, status, input_hash, output_json, updated_at)"
        " VALUES (?,?,?,?,?,?)"
        " ON CONFLICT(session_id, stage) DO UPDATE SET"
        " status=excluded.status, input_hash=excluded.input_hash,"
        " output_json=excluded.output_json, updated_at=excluded.updated_at",
        (session_id, stage, status, input_hash, output_json, now),
    )
    conn.commit()


def get_stage(conn, session_id, stage):
    return conn.execute("SELECT * FROM stages WHERE session_id=? AND stage=?",
                        (session_id, stage)).fetchone()


def set_stage_status(conn, session_id, stage, status, *, now) -> None:
    conn.execute("UPDATE stages SET status=?, updated_at=? WHERE session_id=? AND stage=?",
                 (status, now, session_id, stage))
    conn.commit()


def replace_footage_candidates(conn, session_id, *, scene_index, candidates) -> None:
    """Overwrite the candidate pool for one scene (re-query is destructive-by-scene).

    DELETE + INSERT run in one transaction (``with conn``) so a partial insert can
    never be committed — a half-written pool is worse than no pool for resume."""
    with conn:
        conn.execute("DELETE FROM footage_candidates WHERE session_id=? AND scene_index=?",
                     (session_id, scene_index))
        conn.executemany(
            "INSERT INTO footage_candidates"
            " (session_id, scene_index, rank, query, clip_path, duration_frames, thumb_url,"
            "  selected, kind, source)"
            " VALUES (?,?,?,?,?,?,?,?,?,?)",
            [(session_id, scene_index, c["rank"], c["query"], c.get("clip_path"),
              c.get("duration_frames"), c.get("thumb_url"), int(c.get("selected", 0)),
              c.get("kind", "video"), c.get("source"))
             for c in candidates],
        )


def get_footage_candidates(conn, session_id, *, scene_index):
    return conn.execute(
        "SELECT * FROM footage_candidates WHERE session_id=? AND scene_index=? ORDER BY rank",
        (session_id, scene_index)).fetchall()


def get_footage_candidates_all(conn, session_id) -> dict:
    """{scene_index: [rows]} for ALL scenes in one query (avoids N+1 per-scene hits)."""
    rows = conn.execute(
        "SELECT * FROM footage_candidates WHERE session_id=? ORDER BY scene_index, rank",
        (session_id,)).fetchall()
    result: dict = {}
    for r in rows:
        result.setdefault(r["scene_index"], []).append(r)
    return result


def set_selected_candidate(conn, session_id, *, scene_index, rank) -> None:
    """Mark exactly one candidate selected for the scene (clear-all + set-one in one
    transaction so the scene can never end up with zero selections committed)."""
    with conn:
        conn.execute("UPDATE footage_candidates SET selected=0 WHERE session_id=? AND scene_index=?",
                     (session_id, scene_index))
        conn.execute("UPDATE footage_candidates SET selected=1"
                     " WHERE session_id=? AND scene_index=? AND rank=?",
                     (session_id, scene_index, rank))


def set_candidate_clip_path(conn, session_id, *, scene_index, rank, clip_path) -> None:
    conn.execute("UPDATE footage_candidates SET clip_path=?"
                 " WHERE session_id=? AND scene_index=? AND rank=?",
                 (clip_path, session_id, scene_index, rank))
    conn.commit()


# ---- F-5: assemble patch history (append-only event log) ----
# The spec "version" is DERIVED — v1 is the initial materialize, and every history
# row (a patch apply OR a revert, both are edits) bumps it by one. Deriving from
# the log instead of storing a counter means no sessions-table migration and the
# rail chip can never drift from what the history actually shows.

def append_spec_patch(conn, session_id, *, kind, patch, diff, now, reverts_seq=None) -> int:
    """Append one history entry; returns its seq (1-based, per session)."""
    if kind not in ("patch", "revert"):
        raise ValueError(f"unknown spec_patches kind {kind!r}")
    with conn:
        row = conn.execute("SELECT COALESCE(MAX(seq), 0) + 1 FROM spec_patches"
                           " WHERE session_id=?", (session_id,)).fetchone()
        seq = row[0]
        conn.execute(
            "INSERT INTO spec_patches"
            " (session_id, seq, kind, patch_json, diff_json, reverted, reverts_seq, created_at)"
            " VALUES (?,?,?,?,?,0,?,?)",
            (session_id, seq, kind, _json.dumps(patch), _json.dumps(diff), reverts_seq, now))
    return seq


def get_spec_patches(conn, session_id):
    return conn.execute("SELECT * FROM spec_patches WHERE session_id=? ORDER BY seq",
                        (session_id,)).fetchall()


def mark_patch_reverted(conn, session_id, *, seq) -> None:
    conn.execute("UPDATE spec_patches SET reverted=1 WHERE session_id=? AND seq=?",
                 (session_id, seq))
    conn.commit()


def spec_version(conn, session_id) -> int:
    row = conn.execute("SELECT COUNT(*) FROM spec_patches WHERE session_id=?",
                       (session_id,)).fetchone()
    return 1 + row[0]


# A.2a provenance sources. Fail loud on anything else (house style); A.2b adds
# "uploaded" here with NO migration — the column is plain TEXT, forward-compatible.
_VALID_SOURCES = {"auto", "pick", "re_query", "uploaded"}


def upsert_provenance(conn, session_id, scene_index, *, source, query, rank,
                      pexels_id, pexels_url) -> None:
    """Record current-state provenance for one footage scene (one row per scene)."""
    if source not in _VALID_SOURCES:
        raise ValueError(
            f"unknown provenance source {source!r} (valid: {sorted(_VALID_SOURCES)})")
    conn.execute(
        "INSERT INTO media_provenance"
        " (session_id, scene_index, source, query, rank, pexels_id, pexels_url)"
        " VALUES (?,?,?,?,?,?,?)"
        " ON CONFLICT(session_id, scene_index) DO UPDATE SET"
        " source=excluded.source, query=excluded.query, rank=excluded.rank,"
        " pexels_id=excluded.pexels_id, pexels_url=excluded.pexels_url",
        (session_id, scene_index, source, query, rank, pexels_id, pexels_url),
    )
    conn.commit()


def get_media_provenance(conn, session_id):
    """{scene_index: {source, query, rank, pexels_id, pexels_url}} for the session."""
    rows = conn.execute(
        "SELECT scene_index, source, query, rank, pexels_id, pexels_url"
        " FROM media_provenance WHERE session_id=? ORDER BY scene_index",
        (session_id,)).fetchall()
    return {r["scene_index"]: {"source": r["source"], "query": r["query"], "rank": r["rank"],
                               "pexels_id": r["pexels_id"], "pexels_url": r["pexels_url"]}
            for r in rows}


# ── v3-M1: gate state machine persistence ───────────────────────────────────

GATE_STATES = {"awaiting_approval", "approved", "stale"}


def upsert_gate_state(conn, session_id, gate, state, *, now) -> None:
    """Persist a gate state transition.

    The approval stamp (approved_at) is set only on the first ``approved``
    write and is preserved across later ``stale`` or ``awaiting_approval``
    flips via COALESCE — the Re-approve restore rule (PRD §4.1) reads it.
    """
    if state not in GATE_STATES:
        raise ValueError(f"unknown gate state {state!r}")
    # Supply approved_at only when approving; COALESCE keeps the FIRST stamp
    # across any later flip (ruling 6A: logic lives in Python + SQL, not just SQL).
    approved_at = now if state == "approved" else None
    conn.execute(
        """INSERT INTO gates (session_id, gate, state, approved_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(session_id, gate) DO UPDATE SET
             state=excluded.state,
             approved_at=COALESCE(gates.approved_at, excluded.approved_at),
             updated_at=excluded.updated_at""",
        (session_id, gate, state, approved_at, now),
    )
    conn.commit()


def get_gate_states(conn, session_id) -> dict:
    """{gate: {state, approved_at}} for all gates belonging to the session."""
    rows = conn.execute(
        "SELECT gate, state, approved_at FROM gates WHERE session_id=?",
        (session_id,),
    ).fetchall()
    return {r["gate"]: {"state": r["state"], "approved_at": r["approved_at"]}
            for r in rows}


def set_auto_run(conn, session_id, flag: bool, *, now) -> None:
    """Toggle the auto-run flag (True → 1, False → 0) for a session."""
    conn.execute(
        "UPDATE sessions SET auto_run=?, updated_at=? WHERE id=?",
        (1 if flag else 0, now, session_id),
    )
    conn.commit()


# ── v3-M5: template_overrides and background_overrides ──────────────────────

_OVERRIDE_SOURCES = {"auto", "pinned"}


def upsert_template_override(conn, session_id, scene_index, *, value, source,
                             picked_rank=None, now) -> None:
    """Persist the template override for one scene (one row per scene, upsert)."""
    if source not in _OVERRIDE_SOURCES:
        raise ValueError(
            f"unknown template override source {source!r} (valid: {sorted(_OVERRIDE_SOURCES)})")
    conn.execute(
        "INSERT INTO template_overrides"
        " (session_id, scene_index, value, source, picked_rank, updated_at)"
        " VALUES (?,?,?,?,?,?)"
        " ON CONFLICT(session_id, scene_index) DO UPDATE SET"
        " value=excluded.value, source=excluded.source,"
        " picked_rank=excluded.picked_rank, updated_at=excluded.updated_at",
        (session_id, scene_index, _json.dumps(value), source, picked_rank, now),
    )
    conn.commit()


def get_template_overrides(conn, session_id) -> dict:
    """{scene_index: {value, source, picked_rank, updated_at}} for the session."""
    rows = conn.execute(
        "SELECT scene_index, value, source, picked_rank, updated_at"
        " FROM template_overrides WHERE session_id=? ORDER BY scene_index",
        (session_id,),
    ).fetchall()
    return {
        r["scene_index"]: {
            "value": _json.loads(r["value"]),
            "source": r["source"],
            "picked_rank": r["picked_rank"],
            "updated_at": r["updated_at"],
        }
        for r in rows
    }


def upsert_background_override(conn, session_id, scene_index, *, value, source,
                               picked_rank=None, now) -> None:
    """Persist the background override for one scene (one row per scene, upsert)."""
    if source not in _OVERRIDE_SOURCES:
        raise ValueError(
            f"unknown background override source {source!r} (valid: {sorted(_OVERRIDE_SOURCES)})")
    conn.execute(
        "INSERT INTO background_overrides"
        " (session_id, scene_index, value, source, picked_rank, updated_at)"
        " VALUES (?,?,?,?,?,?)"
        " ON CONFLICT(session_id, scene_index) DO UPDATE SET"
        " value=excluded.value, source=excluded.source,"
        " picked_rank=excluded.picked_rank, updated_at=excluded.updated_at",
        (session_id, scene_index, _json.dumps(value), source, picked_rank, now),
    )
    conn.commit()


def get_background_overrides(conn, session_id) -> dict:
    """{scene_index: {value, source, picked_rank, updated_at}} for the session."""
    rows = conn.execute(
        "SELECT scene_index, value, source, picked_rank, updated_at"
        " FROM background_overrides WHERE session_id=? ORDER BY scene_index",
        (session_id,),
    ).fetchall()
    return {
        r["scene_index"]: {
            "value": _json.loads(r["value"]),
            "source": r["source"],
            "picked_rank": r["picked_rank"],
            "updated_at": r["updated_at"],
        }
        for r in rows
    }


# ── v3-M5: pick_log (②b append-only pick evidence) ──────────────────────────

_PICK_LOG_KINDS = {"footage", "background"}


def append_pick_log(conn, session_id, *, scene_index, kind, query=None,
                    auto_rank=None, human_rank=None, ts) -> int:
    """Append one pick-log entry; returns its seq (1-based, per session).

    seq uses the MAX(seq)+1-per-session-in-a-transaction idiom from
    spec_patches (OV-14: NOT SQLite AUTOINCREMENT which is table-global).
    ts is a required passed-in timestamp (OV-9: engine._now() returns a fixed
    token; genuine time is stamped at the CLI boundary and passed through).
    """
    if kind not in _PICK_LOG_KINDS:
        raise ValueError(
            f"unknown pick_log kind {kind!r} (valid: {sorted(_PICK_LOG_KINDS)})")
    with conn:
        row = conn.execute(
            "SELECT COALESCE(MAX(seq), 0) + 1 FROM pick_log WHERE session_id=?",
            (session_id,),
        ).fetchone()
        seq = row[0]
        conn.execute(
            "INSERT INTO pick_log"
            " (session_id, seq, scene_index, kind, query, auto_rank, human_rank, ts)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (session_id, seq, scene_index, kind, query, auto_rank, human_rank, ts),
        )
    return seq


def get_pick_log(conn, session_id, scene_index=None) -> list:
    """Return pick_log rows in seq order, optionally filtered by scene_index."""
    if scene_index is None:
        return conn.execute(
            "SELECT * FROM pick_log WHERE session_id=? ORDER BY seq",
            (session_id,),
        ).fetchall()
    return conn.execute(
        "SELECT * FROM pick_log WHERE session_id=? AND scene_index=? ORDER BY seq",
        (session_id, scene_index),
    ).fetchall()


def drop_scene_index(conn, session_id, dropped_index: int) -> None:
    """Reconcile every scene_index-keyed table after beat i is dropped.

    Called by engine._edit_script immediately after script.beats.pop(i), before
    re-deriving the plan.  Must run regardless of rederive=True/False because
    these tables hold persisted state, not derived-on-rederive data.

    For EACH of the five scene_index-keyed tables:
      1. DELETE the row(s) at the dropped index (the scene no longer exists).
      2. UPDATE scene_index -= 1 for every row above the drop (shift down).

    Order matters: DELETE before UPDATE prevents a transient PK collision in
    footage_candidates (PK is (session_id, scene_index, rank) — deleting the gap
    first ensures the decrement never collides with an existing lower row).

    All ten statements run in ONE transaction: a crash leaves the tables either
    fully reconciled or untouched — never half-shifted."""
    with conn:
        # ── footage_candidates — PK (session_id, scene_index, rank) ──────────
        conn.execute(
            "DELETE FROM footage_candidates"
            " WHERE session_id=? AND scene_index=?",
            (session_id, dropped_index),
        )
        conn.execute(
            "UPDATE footage_candidates"
            " SET scene_index = scene_index - 1"
            " WHERE session_id=? AND scene_index > ?",
            (session_id, dropped_index),
        )

        # ── media_provenance — PK (session_id, scene_index) ──────────────────
        conn.execute(
            "DELETE FROM media_provenance"
            " WHERE session_id=? AND scene_index=?",
            (session_id, dropped_index),
        )
        conn.execute(
            "UPDATE media_provenance"
            " SET scene_index = scene_index - 1"
            " WHERE session_id=? AND scene_index > ?",
            (session_id, dropped_index),
        )

        # ── template_overrides — PK (session_id, scene_index) ────────────────
        conn.execute(
            "DELETE FROM template_overrides"
            " WHERE session_id=? AND scene_index=?",
            (session_id, dropped_index),
        )
        conn.execute(
            "UPDATE template_overrides"
            " SET scene_index = scene_index - 1"
            " WHERE session_id=? AND scene_index > ?",
            (session_id, dropped_index),
        )

        # ── background_overrides — PK (session_id, scene_index) ──────────────
        conn.execute(
            "DELETE FROM background_overrides"
            " WHERE session_id=? AND scene_index=?",
            (session_id, dropped_index),
        )
        conn.execute(
            "UPDATE background_overrides"
            " SET scene_index = scene_index - 1"
            " WHERE session_id=? AND scene_index > ?",
            (session_id, dropped_index),
        )

        # ── pick_log — PK (session_id, seq); scene_index is a data column ────
        conn.execute(
            "DELETE FROM pick_log"
            " WHERE session_id=? AND scene_index=?",
            (session_id, dropped_index),
        )
        conn.execute(
            "UPDATE pick_log"
            " SET scene_index = scene_index - 1"
            " WHERE session_id=? AND scene_index > ?",
            (session_id, dropped_index),
        )


def delete_session(conn, session_id) -> None:
    """Remove a session and ALL its rows across every keyed table.
    One transaction so a crash can't leave half the session behind. Idempotent."""
    with conn:
        conn.execute("DELETE FROM pick_log WHERE session_id=?", (session_id,))
        conn.execute("DELETE FROM background_overrides WHERE session_id=?", (session_id,))
        conn.execute("DELETE FROM template_overrides WHERE session_id=?", (session_id,))
        conn.execute("DELETE FROM gates WHERE session_id=?", (session_id,))
        conn.execute("DELETE FROM spec_patches WHERE session_id=?", (session_id,))
        conn.execute("DELETE FROM media_provenance WHERE session_id=?", (session_id,))
        conn.execute("DELETE FROM footage_candidates WHERE session_id=?", (session_id,))
        conn.execute("DELETE FROM stages WHERE session_id=?", (session_id,))
        conn.execute("DELETE FROM sessions WHERE id=?", (session_id,))
