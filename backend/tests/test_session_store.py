"""HITL A.1 — SQLite session store. Schema migration is idempotent; sessions,
stage rows, and footage candidate pools round-trip."""
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
