"""Step 6.1 — script.py now emits a structured BeatsScript (title + beats[]),
validated by Pydantic, with a single retry on an invalid LLM reply."""
import json
import pytest

from pipeline.content import BeatsScript
from pipeline.script import generate_script, generate_grounded_script
from pipeline.retrieval import RetrievedContext, RetrievedSnippet


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


# --- Phase 3 (3.1): strict grounded generation ---
# generate_grounded_script retrieves first, injects the evidence into the prompt,
# then ENFORCES that any citation a beat carries is a URL we actually retrieved —
# so citations are trustworthy by construction, not merely present.


def _ctx(*snips):
    """Build a RetrievedContext from (url, title, content) tuples."""
    return RetrievedContext(
        query="topic",
        snippets=[RetrievedSnippet(title=t, url=u, content=c, score=1.0) for (u, t, c) in snips],
    )


def _fake_retrieve(ctx):
    def _f(query, **kwargs):
        return ctx
    return _f


def test_grounded_injects_retrieved_sources_into_prompt():
    ctx = _ctx(("https://noaa.gov/x", "NOAA", "90% of the ocean is unmapped"))
    fake = _FakeClient(_valid(beats=[{"text": "a", "source": "https://noaa.gov/x"}]))
    generate_grounded_script("oceans", provider="deepseek", client=fake, model="m", retrieve_fn=_fake_retrieve(ctx))
    user_msg = fake._completions.captured["messages"][1]["content"]
    assert "https://noaa.gov/x" in user_msg
    assert "90% of the ocean is unmapped" in user_msg


def test_grounded_attaches_cited_sources():
    ctx = _ctx(("https://noaa.gov/x", "NOAA", "fact"))
    fake = _FakeClient(_valid(beats=[{"text": "a", "source": "https://noaa.gov/x"}]))
    out = generate_grounded_script("t", provider="deepseek", client=fake, model="m", retrieve_fn=_fake_retrieve(ctx))
    assert out.sources is not None
    assert out.sources[0].url == "https://noaa.gov/x"
    assert out.sources[0].title == "NOAA"


def test_grounded_strips_source_not_in_retrieved_set():
    ctx = _ctx(("https://noaa.gov/x", "NOAA", "fact"))
    # the model cited a URL we never retrieved → it must be dropped (untrustworthy).
    fake = _FakeClient(_valid(beats=[{"text": "a", "source": "https://made-up.example/z"}]))
    out = generate_grounded_script("t", provider="deepseek", client=fake, model="m", retrieve_fn=_fake_retrieve(ctx))
    assert out.beats[0].source is None
    assert out.sources is None  # nothing validly cited


def test_grounded_keeps_valid_source_and_drops_bogus_one():
    ctx = _ctx(("https://a", "A", "x"), ("https://b", "B", "y"))
    fake = _FakeClient(
        _valid(beats=[{"text": "one", "source": "https://a"}, {"text": "two", "source": "https://nope"}])
    )
    out = generate_grounded_script("t", provider="deepseek", client=fake, model="m", retrieve_fn=_fake_retrieve(ctx))
    assert out.beats[0].source == "https://a"
    assert out.beats[1].source is None
    assert [s.url for s in out.sources] == ["https://a"]
