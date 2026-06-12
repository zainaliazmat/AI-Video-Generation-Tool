"""HITL A.1 — SQLite session store. Schema migration is idempotent; sessions,
stage rows, and footage candidate pools round-trip."""
import pytest
from session import store


def test_connect_creates_schema_and_is_idempotent(tmp_path):
    db = tmp_path / "s.db"
    c1 = store.connect(db); c1.close()
    c2 = store.connect(db)  # opening an existing DB must not error
    tables = {r[0] for r in c2.execute(
        "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    c2.close()
    assert {"sessions", "stages", "footage_candidates"} <= tables


def test_session_and_stage_roundtrip(tmp_path):
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="sess1", topic="Coral Reefs",
                         now="2026-06-10T00:00:00", spec_path="/tmp/spec.json")
    s = store.get_session(conn, "sess1")
    assert s["topic"] == "Coral Reefs" and s["spec_path"] == "/tmp/spec.json"

    store.upsert_stage(conn, "sess1", "script", status="done",
                       input_hash="h1", output_json='{"k":1}', now="2026-06-10T00:01:00")
    row = store.get_stage(conn, "sess1", "script")
    assert row["status"] == "done" and row["input_hash"] == "h1" and row["output_json"] == '{"k":1}'

    store.set_stage_status(conn, "sess1", "script", "stale", now="2026-06-10T00:02:00")
    assert store.get_stage(conn, "sess1", "script")["status"] == "stale"
    assert store.get_stage(conn, "sess1", "missing") is None
    conn.close()


def test_footage_candidates_replace_and_select(tmp_path):
    conn = store.connect(tmp_path / "s.db")
    pool = [
        {"rank": 1, "query": "ocean", "clip_path": None, "duration_frames": 180,
         "thumb_url": "u1", "selected": 1},
        {"rank": 2, "query": "ocean", "clip_path": None, "duration_frames": 300,
         "thumb_url": "u2", "selected": 0},
    ]
    store.replace_footage_candidates(conn, "sess1", scene_index=2, candidates=pool)
    got = store.get_footage_candidates(conn, "sess1", scene_index=2)
    assert [c["rank"] for c in got] == [1, 2]
    assert got[0]["selected"] == 1

    # selecting rank 2 clears rank 1's selected flag (exactly one selected)
    store.set_selected_candidate(conn, "sess1", scene_index=2, rank=2)
    got = store.get_footage_candidates(conn, "sess1", scene_index=2)
    sel = [c["rank"] for c in got if c["selected"]]
    assert sel == [2]

    # replace is idempotent (re-querying the scene overwrites the pool, no dup PK error)
    store.replace_footage_candidates(conn, "sess1", scene_index=2, candidates=pool)
    assert len(store.get_footage_candidates(conn, "sess1", scene_index=2)) == 2
    conn.close()


def test_update_session_sets_fields_and_bumps_updated_at(tmp_path):
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="sess1", topic="T", now="t0")

    store.update_session(conn, "sess1", now="t1", current_stage="script",
                         spec_path="/tmp/spec.json")
    s = store.get_session(conn, "sess1")
    assert s["current_stage"] == "script" and s["spec_path"] == "/tmp/spec.json"
    assert s["updated_at"] == "t1"

    # no fields -> still a valid UPDATE that only bumps updated_at (no SQL syntax error)
    store.update_session(conn, "sess1", now="t2")
    assert store.get_session(conn, "sess1")["updated_at"] == "t2"
    conn.close()


def test_media_provenance_table_created_idempotently(tmp_path):
    db = tmp_path / "s.db"
    store.connect(db).close()
    c2 = store.connect(db)  # reopening an existing DB must not error
    tables = {r[0] for r in c2.execute(
        "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    c2.close()
    assert "media_provenance" in tables


def test_media_provenance_roundtrip_and_overwrite(tmp_path):
    conn = store.connect(tmp_path / "s.db")
    store.upsert_provenance(conn, "s1", 1, source="auto", query="coral reef", rank=1,
                            pexels_id=101, pexels_url="u101")
    assert store.get_media_provenance(conn, "s1") == {
        1: {"source": "auto", "query": "coral reef", "rank": 1,
            "pexels_id": 101, "pexels_url": "u101"}}
    # current-state overwrite on PK conflict (one row per scene)
    store.upsert_provenance(conn, "s1", 1, source="pick", query="coral reef", rank=2,
                            pexels_id=102, pexels_url="u102")
    got = store.get_media_provenance(conn, "s1")
    assert got[1]["source"] == "pick" and got[1]["rank"] == 2 and len(got) == 1
    conn.close()


def test_upsert_provenance_rejects_unknown_source(tmp_path):
    conn = store.connect(tmp_path / "s.db")
    with pytest.raises(ValueError, match="unknown provenance source"):
        store.upsert_provenance(conn, "s1", 0, source="bogus", query="q", rank=1,
                                pexels_id=1, pexels_url="u")
    conn.close()


def test_upsert_provenance_allows_null_rank_for_legacy_clip(tmp_path):
    conn = store.connect(tmp_path / "s.db")
    store.upsert_provenance(conn, "s1", 0, source="auto", query="q", rank=None,
                            pexels_id=None, pexels_url=None)
    assert store.get_media_provenance(conn, "s1")[0]["rank"] is None
    conn.close()


def test_upsert_provenance_accepts_uploaded_source(tmp_path):
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="s1", topic="T", now="t0")
    store.upsert_provenance(conn, "s1", 1, source="uploaded",
                            query="beach-sunset.mp4", rank=None,
                            pexels_id=None, pexels_url=None)
    prov = store.get_media_provenance(conn, "s1")
    assert prov[1] == {"source": "uploaded", "query": "beach-sunset.mp4",
                       "rank": None, "pexels_id": None, "pexels_url": None}
    conn.close()


def test_delete_session_purges_all_tables(tmp_path):
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="auto-x", topic="t", now="now")
    store.upsert_stage(conn, "auto-x", "script", status="done", now="now", output_json="{}")
    store.replace_footage_candidates(conn, "auto-x", scene_index=0, candidates=[
        {"rank": 1, "query": "q", "duration_frames": 30, "thumb_url": "u", "selected": 1}])
    store.upsert_provenance(conn, "auto-x", 0, source="auto", query="q", rank=1,
                            pexels_id=1, pexels_url="u")
    store.delete_session(conn, "auto-x")
    assert store.get_session(conn, "auto-x") is None
    assert store.get_stage(conn, "auto-x", "script") is None
    assert store.get_footage_candidates(conn, "auto-x", scene_index=0) == []
    assert store.get_media_provenance(conn, "auto-x") == {}


# ── v3-M1: gates table + auto_run column ────────────────────────────────────

def test_gate_state_roundtrip_and_approved_at_preserved(tmp_path):
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="s1", topic="t", now="t0")
    store.upsert_gate_state(conn, "s1", "script", "awaiting_approval", now="t1")
    assert store.get_gate_states(conn, "s1")["script"] == {
        "state": "awaiting_approval", "approved_at": None}
    store.upsert_gate_state(conn, "s1", "script", "approved", now="t2")
    assert store.get_gate_states(conn, "s1")["script"] == {
        "state": "approved", "approved_at": "t2"}
    # stale must NOT erase the approval stamp (the Re-approve restore rule reads it)
    store.upsert_gate_state(conn, "s1", "script", "stale", now="t3")
    g = store.get_gate_states(conn, "s1")["script"]
    assert g["state"] == "stale" and g["approved_at"] == "t2"
    conn.close()


def test_unknown_gate_state_rejected(tmp_path):
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="s1", topic="t", now="t0")
    with pytest.raises(ValueError):
        store.upsert_gate_state(conn, "s1", "script", "pending", now="t1")
    conn.close()


def test_auto_run_defaults_false_and_flips(tmp_path):
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="s1", topic="t", now="t0")
    assert store.get_session(conn, "s1")["auto_run"] == 0
    store.set_auto_run(conn, "s1", True, now="t1")
    assert store.get_session(conn, "s1")["auto_run"] == 1
    conn.close()


def test_auto_run_column_migrates_pre_v3_db(tmp_path):
    # simulate a pre-v3 DB: sessions table without the auto_run column
    import sqlite3
    db = tmp_path / "old.db"
    raw = sqlite3.connect(db)
    raw.execute("""CREATE TABLE sessions (
        id TEXT PRIMARY KEY, topic TEXT NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, current_stage TEXT, spec_path TEXT)""")
    raw.execute("INSERT INTO sessions VALUES ('old1','t','c','u',NULL,NULL)")
    raw.commit(); raw.close()
    conn = store.connect(db)   # must ALTER, not crash
    assert store.get_session(conn, "old1")["auto_run"] == 0


def test_delete_session_purges_all_tables_structural(tmp_path):
    """Structural delete test: populate every session_id-keyed table, delete,
    then enumerate sqlite_master and assert zero rows for the sid remain.
    Any future table added to the schema but omitted from delete_session will
    fail this test immediately."""
    conn = store.connect(tmp_path / "s.db")
    sid = "sid-structural"
    store.create_session(conn, id=sid, topic="t", now="t0")

    # populate every table that carries session_id (or id-as-sid for sessions)
    store.upsert_stage(conn, sid, "script", status="done", now="t0", output_json="{}")
    store.replace_footage_candidates(conn, sid, scene_index=0, candidates=[
        {"rank": 1, "query": "q", "duration_frames": 30, "thumb_url": "u", "selected": 1}])
    store.upsert_provenance(conn, sid, 0, source="auto", query="q", rank=1,
                            pexels_id=1, pexels_url="u")
    store.append_spec_patch(conn, sid, kind="patch", patch=[{"op": "add", "path": "/x", "value": 1}],
                            diff=[{"path": "/x", "before": None, "after": 1}], now="t0")
    store.upsert_gate_state(conn, sid, "script", "approved", now="t0")

    def _session_keyed_tables(connection):
        """Return list of (table, id_col) for every table that carries a
        session-identity column.  Mirrors the post-delete check so both loops
        use identical detection logic."""
        tables = [r[0] for r in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()]
        result = []
        for table in tables:
            cols = {r[1] for r in connection.execute(f"PRAGMA table_info({table})")}
            if "session_id" in cols:
                result.append((table, "session_id"))
            elif table == "sessions":
                result.append((table, "id"))
            # else: no session-identity column — skip (e.g. a config table)
        return result

    # Pre-delete completeness check: every session-keyed table must have ≥1
    # row for the test sid.  A future table added to the schema but forgotten
    # in this test's population block will fail HERE, forcing the developer to
    # also update delete_session — which is the whole point of this test.
    for table, id_col in _session_keyed_tables(conn):
        count = conn.execute(
            f"SELECT COUNT(*) FROM {table} WHERE {id_col}=?", (sid,)
        ).fetchone()[0]
        assert count >= 1, (
            f"table '{table}' has no row for the test sid — add it to this "
            f"test's population block AND to delete_session"
        )

    store.delete_session(conn, sid)

    # Post-delete check: zero rows must remain for the sid in every
    # session-keyed table (same detection logic via the helper above).
    for table, id_col in _session_keyed_tables(conn):
        count = conn.execute(
            f"SELECT COUNT(*) FROM {table} WHERE {id_col}=?", (sid,)
        ).fetchone()[0]
        assert count == 0, (
            f"delete_session left {count} orphan row(s) in table '{table}' "
            f"for session '{sid}' — add it to delete_session()"
        )
