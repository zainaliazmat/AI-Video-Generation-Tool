import json
import pytest
from pipeline.script import parse_script_response, generate_script


def test_parse_valid():
    content = json.dumps({"title": " T ", "lines": [" a ", "b"]})
    assert parse_script_response(content) == {"title": "T", "lines": ["a", "b"]}


def test_parse_missing_lines_raises():
    with pytest.raises(ValueError):
        parse_script_response(json.dumps({"title": "T"}))


def test_parse_empty_lines_raises():
    with pytest.raises(ValueError):
        parse_script_response(json.dumps({"title": "T", "lines": []}))


class _FakeMessage:
    def __init__(self, content):
        self.message = type("M", (), {"content": content})


class _FakeCompletions:
    def __init__(self, content):
        self._content = content
        self.captured = {}

    def create(self, **kwargs):
        self.captured = kwargs
        return type("R", (), {"choices": [_FakeMessage(self._content)]})


class _FakeClient:
    def __init__(self, content):
        self.chat = type("C", (), {"completions": _FakeCompletions(content)})()


def test_generate_script_deepseek_with_fake_client():
    fake = _FakeClient(json.dumps({"title": "Deep Sea", "lines": ["one", "two"]}))
    out = generate_script("deep sea", provider="deepseek", client=fake, model="deepseek-v4-flash")
    assert out == {"title": "Deep Sea", "lines": ["one", "two"]}
    assert fake.chat.completions.captured["model"] == "deepseek-v4-flash"
    assert fake.chat.completions.captured["response_format"] == {"type": "json_object"}
