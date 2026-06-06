"""Step 6.1 — script.py now emits a structured BeatsScript (title + beats[]),
validated by Pydantic, with a single retry on an invalid LLM reply."""
import json
import pytest

from pipeline.content import BeatsScript
from pipeline.script import generate_script


class _FakeMessage:
    def __init__(self, content):
        self.message = type("M", (), {"content": content})


class _FakeCompletions:
    """Returns queued contents in order; repeats the last once exhausted."""

    def __init__(self, contents):
        self._contents = list(contents)
        self.calls = 0
        self.captured = {}

    def create(self, **kwargs):
        self.captured = kwargs
        self.calls += 1
        content = self._contents[min(self.calls - 1, len(self._contents) - 1)]
        return type("R", (), {"choices": [_FakeMessage(content)]})


class _FakeClient:
    def __init__(self, *contents):
        self._completions = _FakeCompletions(contents)
        self.chat = type("C", (), {"completions": self._completions})()


def _valid(title="Deep Sea", beats=None):
    beats = beats or [{"text": "one"}, {"text": "two", "data": {"value": "5"}}]
    return json.dumps({"title": title, "beats": beats})


def test_generate_script_returns_beats_script():
    fake = _FakeClient(_valid())
    out = generate_script("deep sea", provider="deepseek", client=fake, model="deepseek-v4-flash")
    assert isinstance(out, BeatsScript)
    assert out.title == "Deep Sea"
    assert out.beats[1].data == {"value": "5"}
    assert fake._completions.captured["model"] == "deepseek-v4-flash"
    assert fake._completions.captured["response_format"] == {"type": "json_object"}
    assert fake._completions.calls == 1


def test_generate_script_retries_once_then_succeeds():
    # First reply is invalid (no beats), second is valid.
    fake = _FakeClient(json.dumps({"title": "T"}), _valid())
    out = generate_script("topic", provider="deepseek", client=fake, model="m")
    assert isinstance(out, BeatsScript)
    assert fake._completions.calls == 2


def test_generate_script_fails_loudly_after_retry():
    fake = _FakeClient(json.dumps({"title": "T"}), json.dumps({"title": "T"}))
    with pytest.raises(ValueError):
        generate_script("topic", provider="deepseek", client=fake, model="m")
    assert fake._completions.calls == 2
