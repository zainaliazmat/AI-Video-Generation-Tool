"""compose_extra_block + script_prefs CLI + per-video override persistence.

The headline guarantee: with no global prefs and no override (and no style memory),
the additive USER block is '' — byte-identical to the pre-prefs pipeline. This is the
regression that protects every existing golden/script test.
"""
import sys, pathlib, json

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))  # backend/

import pytest
from session import prefs as prefs_mod, store, job_ctx
from pipeline import script_prefs, style_memory
import script_prefs_cli


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    """Point every global path at tmp so tests never touch the real repo docs/db."""
    db = tmp_path / "sessions.db"
    monkeypatch.setattr(job_ctx, "SESSIONS_DB", db)
    monkeypatch.setattr(job_ctx, "STYLE_PREFS_PATH", tmp_path / "script_prefs.json")
    monkeypatch.setattr(job_ctx, "STYLE_MEMORY_PATH", tmp_path / "style_memory.json")
    return tmp_path


def test_compose_empty_is_byte_identical_blank(isolated):
    # no prefs, no memory, no override → '' (the golden-prompt guarantee)
    assert prefs_mod.compose_extra_block(None) == ""
    assert prefs_mod.compose_extra_block("missing-sid") == ""


def test_compose_global_prefs_only(isolated):
    script_prefs.save(job_ctx.STYLE_PREFS_PATH, {"tone": "energetic", "hook_style": "question"})
    block = prefs_mod.compose_extra_block(None)
    assert "STYLE PREFERENCES" in block
    assert "energetic and enthusiastic" in block
    assert "direct question" in block


def test_compose_orders_prefs_then_memory_then_feedback(isolated):
    script_prefs.save(job_ctx.STYLE_PREFS_PATH, {"tone": "professional"})
    mem = style_memory.record_guidance(style_memory.load(job_ctx.STYLE_MEMORY_PATH), "punchier verbs")
    style_memory.save(job_ctx.STYLE_MEMORY_PATH, mem)
    block = prefs_mod.compose_extra_block(None, feedback="more numbers")
    i_prefs = block.index("STYLE PREFERENCES")
    i_mem = block.index("STYLE MEMORY")
    i_fb = block.index("OPERATOR FEEDBACK")
    assert i_prefs < i_mem < i_fb


def test_per_video_override_persists_and_wins(isolated):
    script_prefs.save(job_ctx.STYLE_PREFS_PATH, {"tone": "professional", "hook_style": "question"})
    # create a session row carrying a per-video override
    conn = store.connect(job_ctx.SESSIONS_DB)
    store.create_session(conn, id="s1", topic="T", now="created",
                         prefs_override=json.dumps({"tone": "energetic"}))
    conn.close()
    block = prefs_mod.compose_extra_block("s1")
    assert "energetic and enthusiastic" in block   # override wins
    assert "direct question" in block               # global retained


def test_get_prefs_override_none_when_absent(isolated):
    conn = store.connect(job_ctx.SESSIONS_DB)
    store.create_session(conn, id="s2", topic="T", now="created")
    assert store.get_prefs_override(conn, "s2") is None
    conn.close()


def test_cli_save_get_is_initialized_roundtrip(isolated):
    assert script_prefs_cli.is_initialized() == {"ok": True, "initialized": False}
    out = script_prefs_cli.save({"tone": "casual-friendly", "personality": "relatable"})
    assert out["ok"] and out["initialized"]
    assert out["prefs"]["tone"] == "casual-friendly"
    got = script_prefs_cli.get()
    assert got["prefs"]["personality"] == "relatable"
    assert script_prefs_cli.is_initialized()["initialized"] is True


def test_cli_save_normalizes_unknown_keys(isolated):
    out = script_prefs_cli.save({"tone": "energetic", "bogus": "x"})
    assert "bogus" not in out["prefs"]
    assert out["prefs"]["tone"] == "energetic"
