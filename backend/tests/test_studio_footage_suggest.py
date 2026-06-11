"""Studio v2 — Footage suggest-query: LLM proposal passes through the frozen harden()."""
import json

import session_footage
from session import store, job_ctx


def test_suggest_hardens_llm_proposal(tmp_path, monkeypatch):
    db = tmp_path / "s.db"
    monkeypatch.setattr(job_ctx, "SESSIONS_DB", db)
    conn = store.connect(db)
    store.create_session(conn, id="s1", topic="Volcanoes", now="t0")
    bundle = {"script": {"title": "Volcanoes", "beats": [{"text": "Lava reaches 1200C."}]},
              "plan": {"title": "Volcanoes", "scenes": []}}
    store.upsert_stage(conn, "s1", "script", status="done", input_hash="h",
                       output_json=json.dumps(bundle), now="t0")
    conn.close()

    res = session_footage.suggest("s1", scene=0,
                                  llm=lambda messages: json.dumps({"query": "lava flow"}))
    assert res["ok"] and res["raw"] == "lava flow"
    assert isinstance(res["query"], str) and res["query"]   # hardened, non-empty
