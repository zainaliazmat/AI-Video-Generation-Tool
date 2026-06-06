"""Step 6.1 — the structured CONTENT schema DeepSeek returns (validated by Pydantic).

This is the model-output contract (`BeatsScript`), distinct from a template's
inputSchema. The model emits narration `text` + optional structured `data` only —
it never names a template `kind`; the recipe (6.2) derives that.
"""
import json
import pytest
from pydantic import ValidationError

from pipeline.content import Beat, BeatsScript, parse_beats_response


def test_beat_minimal_is_text_only():
    b = Beat.model_validate({"text": "Octopuses have three hearts."})
    assert b.text == "Octopuses have three hearts."
    assert b.data is None
    assert b.keywords is None


def test_beat_carries_optional_data_and_keywords():
    b = Beat.model_validate(
        {"text": "Most of it is unmapped.", "data": {"value": "90%", "label": "unmapped"}, "keywords": "deep ocean"}
    )
    assert b.data == {"value": "90%", "label": "unmapped"}
    assert b.keywords == "deep ocean"


def test_beat_text_is_trimmed():
    assert Beat.model_validate({"text": "  hi  "}).text == "hi"


def test_beat_empty_text_raises():
    with pytest.raises(ValidationError):
        Beat.model_validate({"text": "   "})


def test_beats_script_parses_title_and_beats():
    s = BeatsScript.model_validate(
        {"title": " Deep Sea ", "beats": [{"text": "one"}, {"text": "two"}]}
    )
    assert s.title == "Deep Sea"
    assert [b.text for b in s.beats] == ["one", "two"]


def test_beats_script_empty_beats_raises():
    with pytest.raises(ValidationError):
        BeatsScript.model_validate({"title": "T", "beats": []})


def test_beats_script_blank_title_raises():
    with pytest.raises(ValidationError):
        BeatsScript.model_validate({"title": "   ", "beats": [{"text": "x"}]})


def test_parse_beats_response_from_json_string():
    content = json.dumps({"title": "T", "beats": [{"text": "a"}, {"text": "b", "data": {"value": "5"}}]})
    s = parse_beats_response(content)
    assert isinstance(s, BeatsScript)
    assert s.beats[1].data == {"value": "5"}


def test_parse_beats_response_invalid_json_raises():
    with pytest.raises(ValueError):
        parse_beats_response("not json")


def test_parse_beats_response_schema_violation_raises():
    with pytest.raises(ValueError):
        parse_beats_response(json.dumps({"title": "T"}))  # no beats
