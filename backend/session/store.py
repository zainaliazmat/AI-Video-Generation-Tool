"""SQLite persistence for HITL sessions (stdlib sqlite3, local-first, single-user).

Holds the session document: one `sessions` row, one `stages` row per pipeline
stage (status + input_hash + serialized output), and the per-scene footage
candidate pool. Binaries (audio, clips) stay on disk and are referenced by path;
spec.json stays on disk for the renderer (the renderer never reads this DB).
"""
from __future__ import annotations

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
  PRIMARY KEY (session_id, scene_index, rank)
);
"""


def connect(db_path) -> sqlite3.Connection:
    """Open (creating parent dirs) and ensure the schema. Idempotent."""
    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.executescript(_SCHEMA)
    conn.commit()
    return conn


def create_session(conn, *, id, topic, now, spec_path=None, current_stage=None) -> None:
    conn.execute(
        "INSERT INTO sessions (id, topic, created_at, updated_at, current_stage, spec_path)"
        " VALUES (?,?,?,?,?,?)",
        (id, topic, now, now, current_stage, spec_path),
    )
    conn.commit()


def get_session(conn, session_id):
    return conn.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone()


def update_session(conn, session_id, *, now, **fields) -> None:
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
    """Overwrite the candidate pool for one scene (re-query is destructive-by-scene)."""
    conn.execute("DELETE FROM footage_candidates WHERE session_id=? AND scene_index=?",
                 (session_id, scene_index))
    conn.executemany(
        "INSERT INTO footage_candidates"
        " (session_id, scene_index, rank, query, clip_path, duration_frames, thumb_url, selected)"
        " VALUES (?,?,?,?,?,?,?,?)",
        [(session_id, scene_index, c["rank"], c["query"], c.get("clip_path"),
          c.get("duration_frames"), c.get("thumb_url"), int(c.get("selected", 0)))
         for c in candidates],
    )
    conn.commit()


def get_footage_candidates(conn, session_id, *, scene_index):
    return conn.execute(
        "SELECT * FROM footage_candidates WHERE session_id=? AND scene_index=? ORDER BY rank",
        (session_id, scene_index)).fetchall()


def set_selected_candidate(conn, session_id, *, scene_index, rank) -> None:
    """Mark exactly one candidate selected for the scene."""
    conn.execute("UPDATE footage_candidates SET selected=0 WHERE session_id=? AND scene_index=?",
                 (session_id, scene_index))
    conn.execute("UPDATE footage_candidates SET selected=1"
                 " WHERE session_id=? AND scene_index=? AND rank=?",
                 (session_id, scene_index, rank))
    conn.commit()


def set_candidate_clip_path(conn, session_id, *, scene_index, rank, clip_path) -> None:
    conn.execute("UPDATE footage_candidates SET clip_path=?"
                 " WHERE session_id=? AND scene_index=? AND rank=?",
                 (clip_path, session_id, scene_index, rank))
    conn.commit()
