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


def test_target_length_defaults_60_and_roundtrips(tmp_path):
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="s1", topic="t", now="t0")
    assert store.get_session(conn, "s1")["target_length"] == 60

    store.create_session(conn, id="s2", topic="t", now="t0", target_length=180)
    assert store.get_session(conn, "s2")["target_length"] == 180
    conn.close()


def test_target_length_column_migrates_pre_v3_db(tmp_path):
    # simulate a pre-v3 DB: sessions table with auto_run but no target_length
    import sqlite3
    db = tmp_path / "old.db"
    raw = sqlite3.connect(db)
    raw.execute("""CREATE TABLE sessions (
        id TEXT PRIMARY KEY, topic TEXT NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, current_stage TEXT, spec_path TEXT,
        auto_run INTEGER NOT NULL DEFAULT 0)""")
    raw.execute("INSERT INTO sessions VALUES ('old1','t','c','u',NULL,NULL,0)")
    raw.commit(); raw.close()
    conn = store.connect(db)   # must ALTER to add target_length, not crash
    assert store.get_session(conn, "old1")["target_length"] == 60


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
    store.upsert_template_override(conn, sid, 0, value={"template": "basic"}, source="auto", now="t0")
    store.upsert_background_override(conn, sid, 0, value={"color": "#000"}, source="pinned",
                                     picked_rank=1, now="t0")
    store.append_pick_log(conn, sid, scene_index=0, kind="footage", query="coral",
                          auto_rank=1, human_rank=2, ts="2026-06-13T00:00:00")

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


# ── v3-M5: template_overrides and background_overrides ──────────────────────

def test_template_override_roundtrip(tmp_path):
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="s1", topic="t", now="t0")
    store.upsert_template_override(conn, "s1", 0, value={"template": "basic"}, source="auto", now="t1")
    got = store.get_template_overrides(conn, "s1")
    assert got == {0: {"value": {"template": "basic"}, "source": "auto",
                       "picked_rank": None, "updated_at": "t1"}}
    conn.close()


def test_template_override_upsert_overwrites(tmp_path):
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="s1", topic="t", now="t0")
    store.upsert_template_override(conn, "s1", 0, value={"template": "basic"}, source="auto", now="t1")
    store.upsert_template_override(conn, "s1", 0, value={"template": "cinema"}, source="pinned",
                                   picked_rank=3, now="t2")
    got = store.get_template_overrides(conn, "s1")
    assert got[0]["value"] == {"template": "cinema"}
    assert got[0]["source"] == "pinned"
    assert got[0]["picked_rank"] == 3
    assert got[0]["updated_at"] == "t2"
    conn.close()


def test_template_override_rejects_bad_source(tmp_path):
    conn = store.connect(tmp_path / "s.db")
    with pytest.raises(ValueError, match="unknown template override source"):
        store.upsert_template_override(conn, "s1", 0, value={}, source="bogus", now="t0")
    conn.close()


def test_template_override_picked_rank_nullable(tmp_path):
    conn = store.connect(tmp_path / "s.db")
    store.upsert_template_override(conn, "s1", 2, value={"x": 1}, source="auto",
                                   picked_rank=None, now="t0")
    assert store.get_template_overrides(conn, "s1")[2]["picked_rank"] is None
    conn.close()


def test_background_override_roundtrip(tmp_path):
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="s1", topic="t", now="t0")
    store.upsert_background_override(conn, "s1", 1, value={"color": "#fff"}, source="pinned",
                                     picked_rank=2, now="t1")
    got = store.get_background_overrides(conn, "s1")
    assert got == {1: {"value": {"color": "#fff"}, "source": "pinned",
                       "picked_rank": 2, "updated_at": "t1"}}
    conn.close()


def test_background_override_upsert_overwrites(tmp_path):
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="s1", topic="t", now="t0")
    store.upsert_background_override(conn, "s1", 0, value={"color": "#000"}, source="auto", now="t1")
    store.upsert_background_override(conn, "s1", 0, value={"color": "#red"}, source="pinned",
                                     picked_rank=1, now="t2")
    got = store.get_background_overrides(conn, "s1")
    assert got[0]["value"] == {"color": "#red"}
    assert got[0]["source"] == "pinned"
    assert got[0]["updated_at"] == "t2"
    conn.close()


def test_background_override_rejects_bad_source(tmp_path):
    conn = store.connect(tmp_path / "s.db")
    with pytest.raises(ValueError, match="unknown background override source"):
        store.upsert_background_override(conn, "s1", 0, value={}, source="invalid", now="t0")
    conn.close()


def test_background_override_picked_rank_nullable(tmp_path):
    conn = store.connect(tmp_path / "s.db")
    store.upsert_background_override(conn, "s1", 3, value={"x": 2}, source="auto",
                                     picked_rank=None, now="t0")
    assert store.get_background_overrides(conn, "s1")[3]["picked_rank"] is None
    conn.close()


# ── v3-M5: pick_log (②b append-only pick evidence) ──────────────────────────

def test_pick_log_appends_preserve_order(tmp_path):
    conn = store.connect(tmp_path / "s.db")
    store.append_pick_log(conn, "s1", scene_index=0, kind="footage",
                          query="coral", auto_rank=1, human_rank=2,
                          ts="2026-06-13T00:00:01")
    store.append_pick_log(conn, "s1", scene_index=1, kind="background",
                          query="ocean", auto_rank=3, human_rank=3,
                          ts="2026-06-13T00:00:02")
    store.append_pick_log(conn, "s1", scene_index=0, kind="footage",
                          query="reef", auto_rank=2, human_rank=1,
                          ts="2026-06-13T00:00:03")
    rows = store.get_pick_log(conn, "s1")
    assert [r["seq"] for r in rows] == [1, 2, 3]
    assert [r["scene_index"] for r in rows] == [0, 1, 0]
    conn.close()


def test_pick_log_seq_is_per_session(tmp_path):
    """Two different sessions both get seq starting at 1 (OV-14 point)."""
    conn = store.connect(tmp_path / "s.db")
    store.append_pick_log(conn, "sA", scene_index=0, kind="footage",
                          query="q1", ts="2026-06-13T00:00:01")
    store.append_pick_log(conn, "sA", scene_index=1, kind="footage",
                          query="q2", ts="2026-06-13T00:00:02")
    store.append_pick_log(conn, "sB", scene_index=0, kind="background",
                          query="q3", ts="2026-06-13T00:00:03")
    rows_a = store.get_pick_log(conn, "sA")
    rows_b = store.get_pick_log(conn, "sB")
    assert [r["seq"] for r in rows_a] == [1, 2]
    assert [r["seq"] for r in rows_b] == [1]
    conn.close()


def test_pick_log_ts_stored_verbatim(tmp_path):
    """ts is whatever the caller passes — not derived from engine._now()."""
    conn = store.connect(tmp_path / "s.db")
    ts = "2026-06-13T12:34:56.789Z"
    store.append_pick_log(conn, "s1", scene_index=0, kind="footage", ts=ts)
    rows = store.get_pick_log(conn, "s1")
    assert rows[0]["ts"] == ts
    conn.close()


def test_pick_log_scene_filter(tmp_path):
    conn = store.connect(tmp_path / "s.db")
    store.append_pick_log(conn, "s1", scene_index=0, kind="footage", ts="t1")
    store.append_pick_log(conn, "s1", scene_index=2, kind="background", ts="t2")
    store.append_pick_log(conn, "s1", scene_index=0, kind="footage", ts="t3")
    filtered = store.get_pick_log(conn, "s1", scene_index=0)
    assert all(r["scene_index"] == 0 for r in filtered)
    assert len(filtered) == 2
    conn.close()


def test_pick_log_optional_fields_nullable(tmp_path):
    conn = store.connect(tmp_path / "s.db")
    store.append_pick_log(conn, "s1", scene_index=0, kind="footage", ts="t1")
    row = store.get_pick_log(conn, "s1")[0]
    assert row["query"] is None
    assert row["auto_rank"] is None
    assert row["human_rank"] is None
    conn.close()


def test_pick_log_rejects_bad_kind(tmp_path):
    conn = store.connect(tmp_path / "s.db")
    with pytest.raises(ValueError, match="unknown pick_log kind"):
        store.append_pick_log(conn, "s1", scene_index=0, kind="video", ts="t1")
    conn.close()


def test_pick_log_migration_safety_new_tables_on_pre_m5_db(tmp_path):
    """A pre-M5 DB (all previous tables, no override/pick_log tables) connects
    cleanly — IF NOT EXISTS means new tables are created on first connect."""
    import sqlite3 as _sqlite3
    db = tmp_path / "pre_m5.db"
    raw = _sqlite3.connect(db)
    # Create only the tables that existed before M5
    raw.executescript("""
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY, topic TEXT NOT NULL, created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL, current_stage TEXT, spec_path TEXT,
            auto_run INTEGER NOT NULL DEFAULT 0,
            target_length INTEGER NOT NULL DEFAULT 60
        );
        CREATE TABLE stages (
            session_id TEXT NOT NULL, stage TEXT NOT NULL, status TEXT NOT NULL,
            input_hash TEXT, output_json TEXT, updated_at TEXT NOT NULL,
            PRIMARY KEY (session_id, stage)
        );
        CREATE TABLE footage_candidates (
            session_id TEXT NOT NULL, scene_index INTEGER NOT NULL, rank INTEGER NOT NULL,
            query TEXT NOT NULL, clip_path TEXT, duration_frames INTEGER,
            thumb_url TEXT, selected INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (session_id, scene_index, rank)
        );
        CREATE TABLE media_provenance (
            session_id TEXT NOT NULL, scene_index INTEGER NOT NULL,
            source TEXT NOT NULL, query TEXT, rank INTEGER,
            pexels_id INTEGER, pexels_url TEXT,
            PRIMARY KEY (session_id, scene_index)
        );
        CREATE TABLE spec_patches (
            session_id TEXT NOT NULL, seq INTEGER NOT NULL,
            kind TEXT NOT NULL DEFAULT 'patch', patch_json TEXT NOT NULL,
            diff_json TEXT NOT NULL, reverted INTEGER NOT NULL DEFAULT 0,
            reverts_seq INTEGER, created_at TEXT NOT NULL,
            PRIMARY KEY (session_id, seq)
        );
        CREATE TABLE gates (
            session_id TEXT NOT NULL, gate TEXT NOT NULL, state TEXT NOT NULL,
            approved_at TEXT, updated_at TEXT NOT NULL,
            PRIMARY KEY (session_id, gate)
        );
    """)
    raw.execute("INSERT INTO sessions VALUES ('old1','t','c','u',NULL,NULL,0,60)")
    raw.commit()
    raw.close()
    conn = store.connect(db)   # must create new tables without error
    tables = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    assert {"template_overrides", "background_overrides", "pick_log"} <= tables
    # existing session still readable
    assert store.get_session(conn, "old1")["topic"] == "t"
    conn.close()


# ── v3-M5 critical fix: drop_scene_index reconciles all five keyed tables ────

def _seed_all_five_tables(conn, sid, indices):
    """Seed rows at each index in `indices` across all five scene_index-keyed tables."""
    for i in indices:
        # footage_candidates — PK (session_id, scene_index, rank)
        store.replace_footage_candidates(conn, sid, scene_index=i, candidates=[
            {"rank": 1, "query": f"q{i}", "duration_frames": 30,
             "thumb_url": f"t{i}", "selected": 0},
        ])
        # media_provenance — PK (session_id, scene_index)
        store.upsert_provenance(conn, sid, i, source="auto", query=f"q{i}",
                                rank=1, pexels_id=i + 100, pexels_url=f"u{i}")
        # template_overrides — PK (session_id, scene_index)
        store.upsert_template_override(conn, sid, i, value=f"tmpl{i}",
                                       source="auto", now=f"t{i}")
        # background_overrides — PK (session_id, scene_index)
        store.upsert_background_override(conn, sid, i, value={"path": f"bg{i}.mp4"},
                                         source="auto", picked_rank=1, now=f"t{i}")
        # pick_log — PK (session_id, seq); scene_index is a data column
        store.append_pick_log(conn, sid, scene_index=i, kind="footage",
                              query=f"q{i}", ts=f"t{i}")


def test_drop_scene_index_removes_dropped_and_shifts_higher(tmp_path):
    """drop_scene_index(conn, sid, 1): rows at index 1 gone; 2→1, 3→2; index 0 untouched."""
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="s1", topic="t", now="t0")
    _seed_all_five_tables(conn, "s1", [0, 1, 2, 3])

    store.drop_scene_index(conn, "s1", 1)

    # ── footage_candidates ────────────────────────────────────────────────────
    def _fc_indices(c, sid):
        return {r["scene_index"] for r in c.execute(
            "SELECT scene_index FROM footage_candidates WHERE session_id=?", (sid,)
        ).fetchall()}

    assert _fc_indices(conn, "s1") == {0, 1, 2}, (
        "footage_candidates: index 1 dropped, 2→1, 3→2; 0 untouched")

    # ── media_provenance ──────────────────────────────────────────────────────
    prov = store.get_media_provenance(conn, "s1")
    assert set(prov.keys()) == {0, 1, 2}, (
        f"media_provenance: expected indices {{0,1,2}}; got {set(prov.keys())}")
    assert prov[0]["query"] == "q0"   # index 0 untouched
    assert prov[1]["query"] == "q2"   # was index 2
    assert prov[2]["query"] == "q3"   # was index 3

    # ── template_overrides ────────────────────────────────────────────────────
    tmpl = store.get_template_overrides(conn, "s1")
    assert set(tmpl.keys()) == {0, 1, 2}, (
        f"template_overrides: expected indices {{0,1,2}}; got {set(tmpl.keys())}")
    assert tmpl[0]["value"] == "tmpl0"
    assert tmpl[1]["value"] == "tmpl2"
    assert tmpl[2]["value"] == "tmpl3"

    # ── background_overrides ──────────────────────────────────────────────────
    bg = store.get_background_overrides(conn, "s1")
    assert set(bg.keys()) == {0, 1, 2}, (
        f"background_overrides: expected indices {{0,1,2}}; got {set(bg.keys())}")
    assert bg[0]["value"]["path"] == "bg0.mp4"
    assert bg[1]["value"]["path"] == "bg2.mp4"
    assert bg[2]["value"]["path"] == "bg3.mp4"

    # ── pick_log ──────────────────────────────────────────────────────────────
    pl = store.get_pick_log(conn, "s1")
    assert [r["scene_index"] for r in pl] == [0, 1, 2], (
        f"pick_log: expected scene_indices [0,1,2] after drop; got "
        f"{[r['scene_index'] for r in pl]}")
    assert pl[1]["query"] == "q2"   # was index 2
    assert pl[2]["query"] == "q3"   # was index 3

    conn.close()


def test_drop_scene_index_dropped_row_gone_in_every_table(tmp_path):
    """The row at the dropped index is completely absent from all five tables."""
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="s1", topic="t", now="t0")
    _seed_all_five_tables(conn, "s1", [0, 1, 2, 3])

    store.drop_scene_index(conn, "s1", 1)

    # footage_candidates
    assert store.get_footage_candidates(conn, "s1", scene_index=1) == [] or \
        all(r["query"] != "q1" for r in store.get_footage_candidates(conn, "s1", scene_index=1)), (
        "footage_candidates: original index-1 row must be gone")
    # media_provenance
    prov = store.get_media_provenance(conn, "s1")
    # index 1's original query was "q1"; after shift index 1 should have "q2"
    assert prov.get(1, {}).get("query") != "q1", "media_provenance: original index-1 row must be gone"
    # template_overrides
    tmpl = store.get_template_overrides(conn, "s1")
    assert tmpl.get(1, {}).get("value") != "tmpl1", "template_overrides: original index-1 row must be gone"
    # background_overrides
    bg = store.get_background_overrides(conn, "s1")
    assert bg.get(1, {}).get("value", {}).get("path") != "bg1.mp4", (
        "background_overrides: original index-1 row must be gone")
    # pick_log
    pl = store.get_pick_log(conn, "s1")
    assert not any(r["scene_index"] == 1 and r["query"] == "q1" for r in pl), (
        "pick_log: original index-1 row must be gone")

    conn.close()


def test_drop_scene_index_index_zero_untouched_in_every_table(tmp_path):
    """After dropping index 1, index-0 rows in all five tables are completely untouched."""
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="s1", topic="t", now="t0")
    _seed_all_five_tables(conn, "s1", [0, 1, 2, 3])

    store.drop_scene_index(conn, "s1", 1)

    prov = store.get_media_provenance(conn, "s1")
    assert prov[0]["query"] == "q0", "media_provenance index 0 must be untouched"

    tmpl = store.get_template_overrides(conn, "s1")
    assert tmpl[0]["value"] == "tmpl0", "template_overrides index 0 must be untouched"

    bg = store.get_background_overrides(conn, "s1")
    assert bg[0]["value"]["path"] == "bg0.mp4", "background_overrides index 0 must be untouched"

    pl = store.get_pick_log(conn, "s1")
    assert pl[0]["query"] == "q0", "pick_log index 0 must be untouched"

    conn.close()


def test_drop_scene_index_no_cross_session_contamination(tmp_path):
    """drop_scene_index for session A must not touch session B's rows."""
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="sA", topic="t", now="t0")
    store.create_session(conn, id="sB", topic="t", now="t0")
    _seed_all_five_tables(conn, "sA", [0, 1, 2])
    _seed_all_five_tables(conn, "sB", [0, 1, 2])

    store.drop_scene_index(conn, "sA", 1)

    # sB must be completely untouched
    prov_b = store.get_media_provenance(conn, "sB")
    assert set(prov_b.keys()) == {0, 1, 2}, "sB media_provenance must be untouched"
    tmpl_b = store.get_template_overrides(conn, "sB")
    assert set(tmpl_b.keys()) == {0, 1, 2}, "sB template_overrides must be untouched"
    bg_b = store.get_background_overrides(conn, "sB")
    assert set(bg_b.keys()) == {0, 1, 2}, "sB background_overrides must be untouched"
    pl_b = store.get_pick_log(conn, "sB")
    assert [r["scene_index"] for r in pl_b] == [0, 1, 2], "sB pick_log must be untouched"

    conn.close()
