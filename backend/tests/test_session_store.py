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
