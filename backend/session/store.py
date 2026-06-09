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
