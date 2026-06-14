"""Channel-voice script preferences — store + merge + additive prompt block.

Mirrors the style_memory test discipline: empty → '' (byte-identical prompt),
load is corrupt-safe, merge prefers non-empty override, and the rendered block is
soft-guidance framed (never overrides grounding).
"""
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))  # backend/

from pipeline import script_prefs


def test_empty_block_is_blank():
    assert script_prefs.to_prompt_block(script_prefs.EMPTY) == ""
    assert script_prefs.to_prompt_block({}) == ""


def test_is_initialized_false_on_missing_file(tmp_path):
    assert script_prefs.is_initialized(tmp_path / "nope.json") is False


def test_is_initialized_false_on_all_empty(tmp_path):
    p = tmp_path / "script_prefs.json"
    script_prefs.save(p, script_prefs.EMPTY)
    assert script_prefs.is_initialized(p) is False


def test_save_load_roundtrip_and_initialized(tmp_path):
    p = tmp_path / "script_prefs.json"
    script_prefs.save(p, {"tone": "energetic", "hook_style": "question"})
    assert script_prefs.is_initialized(p) is True
    loaded = script_prefs.load(p)
    assert loaded["tone"] == "energetic"
    assert loaded["hook_style"] == "question"
    # missing keys backfilled to the empty shape
    assert loaded["audience"] == {"age_range": "", "knowledge_level": "", "interests": []}


def test_load_corrupt_file_returns_empty(tmp_path):
    p = tmp_path / "script_prefs.json"
    p.write_text("{ not json")
    assert script_prefs.load(p) == script_prefs.EMPTY
    assert script_prefs.is_initialized(p) is False


def test_block_renders_set_fields_only():
    block = script_prefs.to_prompt_block({"tone": "casual-friendly", "hook_style": "question"})
    assert "STYLE PREFERENCES" in block
    assert "casual and friendly" in block
    assert "direct question" in block
    # unset fields produce no line
    assert "Personality" not in block
    assert "Channel niche" not in block
    # the grounding-safety framing is present
    assert "NOT rules that override grounding" in block


def test_statistics_line_keeps_source_guard():
    block = script_prefs.to_prompt_block({"style": {"use_statistics": "heavy"}})
    assert "only when a source supports them" in block


def test_merge_override_wins_field_by_field():
    glob = {"tone": "casual-friendly", "hook_style": "question",
            "personality": "relatable"}
    override = {"tone": "energetic"}
    merged = script_prefs.merge(glob, override)
    assert merged["tone"] == "energetic"          # override wins
    assert merged["hook_style"] == "question"     # global retained
    assert merged["personality"] == "relatable"   # global retained


def test_merge_empty_override_is_global():
    glob = {"tone": "professional"}
    assert script_prefs.merge(glob, None)["tone"] == "professional"
    assert script_prefs.merge(glob, {})["tone"] == "professional"


def test_merge_use_questions_false_override_wins():
    glob = {"style": {"use_questions": True}}
    merged = script_prefs.merge(glob, {"style": {"use_questions": False}})
    assert merged["style"]["use_questions"] is False


def test_merge_nested_audience_per_subkey():
    glob = {"audience": {"age_range": "20s-30s", "knowledge_level": "beginner"}}
    merged = script_prefs.merge(glob, {"audience": {"knowledge_level": "expert"}})
    assert merged["audience"]["age_range"] == "20s-30s"     # retained
    assert merged["audience"]["knowledge_level"] == "expert"  # overridden


def test_audience_line_composes_bits():
    block = script_prefs.to_prompt_block(
        {"audience": {"age_range": "20s-30s", "knowledge_level": "beginners",
                      "interests": ["productivity", "tech"]}})
    assert "Audience: beginners, 20s-30s, into productivity, tech" in block
