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
