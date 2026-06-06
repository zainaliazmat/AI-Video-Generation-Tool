"""Step 6.1 — script.py now emits a structured BeatsScript (title + beats[]),
validated by Pydantic, with a single retry on an invalid LLM reply."""
import json
import pytest

from pipeline.content import Beat, BeatsScript, HookCandidate
from pipeline.script import (
    generate_script,
    generate_grounded_script,
    _reselect_hook_if_dropped,
    _count_agnostic_title,
    _enforce_floor,
)
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
    generate_grounded_script("oceans", provider="deepseek", client=fake, model="m", retrieve_fn=_fake_retrieve(ctx), verify=False)
    user_msg = fake._completions.captured["messages"][1]["content"]
    assert "https://noaa.gov/x" in user_msg
    assert "90% of the ocean is unmapped" in user_msg


def test_grounded_attaches_cited_sources():
    ctx = _ctx(("https://noaa.gov/x", "NOAA", "fact"))
    fake = _FakeClient(_valid(beats=[{"text": "a", "source": "https://noaa.gov/x"}]))
    out = generate_grounded_script("t", provider="deepseek", client=fake, model="m", retrieve_fn=_fake_retrieve(ctx), verify=False)
    assert out.sources is not None
    assert out.sources[0].url == "https://noaa.gov/x"
    assert out.sources[0].title == "NOAA"


def test_grounded_strips_source_not_in_retrieved_set():
    ctx = _ctx(("https://noaa.gov/x", "NOAA", "fact"))
    # the model cited a URL we never retrieved → it must be dropped (untrustworthy).
    fake = _FakeClient(_valid(beats=[{"text": "a", "source": "https://made-up.example/z"}]))
    out = generate_grounded_script("t", provider="deepseek", client=fake, model="m", retrieve_fn=_fake_retrieve(ctx), verify=False)
    assert out.beats[0].source is None
    assert out.sources is None  # nothing validly cited


def test_grounded_keeps_valid_source_and_drops_bogus_one():
    ctx = _ctx(("https://a", "A", "x"), ("https://b", "B", "y"))
    fake = _FakeClient(
        _valid(beats=[{"text": "one", "source": "https://a"}, {"text": "two", "source": "https://nope"}])
    )
    out = generate_grounded_script("t", provider="deepseek", client=fake, model="m", retrieve_fn=_fake_retrieve(ctx), verify=False)
    assert out.beats[0].source == "https://a"
    assert out.beats[1].source is None
    assert [s.url for s in out.sources] == ["https://a"]


# --- Phase 3.2: grounded hook candidate generation + deterministic selection ---


def _script_json(beats, hooks=None, title="T"):
    obj = {"title": title, "beats": beats}
    if hooks is not None:
        obj["hook_candidates"] = hooks
    return json.dumps(obj)


def test_grounded_selects_highest_scoring_hook_as_beat0():
    ctx = _ctx(("https://a", "A", "snippet"))
    content = _script_json(
        beats=[{"text": "Let me tell you about the ocean."}, {"text": "body", "source": "https://a"}, {"text": "Follow for more."}],
        hooks=[{"text": "90% of the ocean is unmapped — why?", "pattern": "surprising stat", "source": "https://a"}],
    )
    out = generate_grounded_script("t", provider="deepseek", client=_FakeClient(content), model="m", retrieve_fn=_fake_retrieve(ctx), verify=False)
    assert out.beats[0].text == "90% of the ocean is unmapped — why?"   # the stronger candidate becomes beat 0
    assert out.beats[0].source == "https://a"
    chosen = [h for h in out.hook_candidates if h.chosen]
    assert len(chosen) == 1 and chosen[0].text == "90% of the ocean is unmapped — why?"


def test_grounded_falls_back_to_model_opener_when_no_candidates():
    ctx = _ctx(("https://a", "A", "s"))
    content = _script_json(beats=[{"text": "Original opener."}, {"text": "Follow."}], hooks=None)
    out = generate_grounded_script("t", provider="deepseek", client=_FakeClient(content), model="m", retrieve_fn=_fake_retrieve(ctx), verify=False)
    assert out.beats[0].text == "Original opener."                       # unchanged — its own opener competes and wins by default
    assert out.hook_candidates is not None and len(out.hook_candidates) == 1
    assert out.hook_candidates[0].chosen is True


def test_grounded_strips_chosen_hook_source_not_retrieved():
    ctx = _ctx(("https://a", "A", "s"))
    content = _script_json(
        beats=[{"text": "Weak."}, {"text": "Follow."}],
        hooks=[{"text": "An amazing 11 km deep — really?", "pattern": "surprising stat", "source": "https://not-retrieved"}],
    )
    out = generate_grounded_script("t", provider="deepseek", client=_FakeClient(content), model="m", retrieve_fn=_fake_retrieve(ctx), verify=False)
    assert out.beats[0].text == "An amazing 11 km deep — really?"        # still wins on number+question+brevity
    assert out.beats[0].source is None                                  # bogus source dropped → no false citation on the hook


def test_grounded_retains_all_hook_candidates_scored():
    ctx = _ctx(("https://a", "A", "s"))
    content = _script_json(
        beats=[{"text": "Default opener here now."}, {"text": "Follow."}],
        hooks=[
            {"text": "Plain statement about oceans.", "pattern": "bold claim"},
            {"text": "Did you know 90% is unmapped?", "pattern": "surprising stat", "source": "https://a"},
        ],
    )
    out = generate_grounded_script("t", provider="deepseek", client=_FakeClient(content), model="m", retrieve_fn=_fake_retrieve(ctx), verify=False)
    assert len(out.hook_candidates) == 3                                 # 2 model candidates + the model's own opener
    assert all(h.score is not None for h in out.hook_candidates)
    assert sum(1 for h in out.hook_candidates if h.chosen) == 1
    assert out.beats[0].text == "Did you know 90% is unmapped?"          # grounded stat-question wins


# --- Phase 3.3: verify wired into grounded generation (default-on, skippable) ---


def test_grounded_verify_drops_unsupported_beat():
    ctx = _ctx(("https://a", "A", "snip"))
    content = _script_json(
        beats=[
            {"text": "hook", "source": "https://a"},
            {"text": "a good fact", "source": "https://a"},
            {"text": "bad claim", "source": "https://a"},
            {"text": "Follow."},
        ]
    )

    def vfn(items):  # support everything except the "bad" claim
        return [
            {
                "index": it["index"],
                "claim_supported": "bad" not in it["claim"],
                "number_supported": None,
                "source": "https://a" if "bad" not in it["claim"] else None,
            }
            for it in items
        ]

    out = generate_grounded_script(
        "t", provider="deepseek", client=_FakeClient(content), model="m",
        retrieve_fn=_fake_retrieve(ctx), verify_fn=vfn,
    )
    assert "bad claim" not in [b.text for b in out.beats]   # unsupported claim dropped by verify
    assert "a good fact" in [b.text for b in out.beats]      # supported claim kept (and clears the floor)
    assert out.verify_report is not None


def test_grounded_verify_false_skips_verification():
    ctx = _ctx(("https://a", "A", "snip"))
    content = _script_json(beats=[{"text": "hook", "source": "https://a"}, {"text": "unchecked", "source": "https://a"}])
    out = generate_grounded_script(
        "t", provider="deepseek", client=_FakeClient(content), model="m",
        retrieve_fn=_fake_retrieve(ctx), verify=False,
    )
    assert "unchecked" in [b.text for b in out.beats]   # not verified → not dropped
    assert out.verify_report is None


# --- Phase 3.3: count-agnostic titles + hook re-selection on drop ---


def test_count_agnostic_title_strips_leading_count():
    assert _count_agnostic_title("3 Surprising Facts About the Deep Ocean") == "Surprising Facts About the Deep Ocean"
    assert _count_agnostic_title("Top 5 Ocean Facts") == "Ocean Facts"
    assert _count_agnostic_title("The Deep Ocean") == "The Deep Ocean"  # no count → unchanged


def test_reselect_hook_promotes_supported_alternative():
    ctx = _ctx(("https://a", "A", "snip"))
    script = BeatsScript(
        title="Topic",
        beats=[Beat(text="surviving fact", source="https://a"), Beat(text="outro")],  # chosen hook was dropped
        hook_candidates=[
            HookCandidate(text="dropped hook", source="https://a", score=5.0, chosen=True),
            HookCandidate(text="good alt", source="https://a", score=4.0),
            HookCandidate(text="bad alt", source="https://a", score=3.0),
        ],
    )

    def vfn(items):
        return [
            {"index": it["index"], "claim_supported": it["claim"] == "good alt",
             "number_supported": None, "source": "https://a" if it["claim"] == "good alt" else None}
            for it in items
        ]

    _reselect_hook_if_dropped(script, ctx, vfn)
    assert script.beats[0].text == "good alt"  # best supported grounded alternative promoted to hook


def test_reselect_hook_falls_back_to_title_when_none_verify():
    ctx = _ctx(("https://a", "A", "s"))
    script = BeatsScript(
        title="The Deep Ocean",
        beats=[Beat(text="fact", source="https://a"), Beat(text="outro")],
        hook_candidates=[
            HookCandidate(text="dropped", source="https://a", score=5.0, chosen=True),
            HookCandidate(text="alt", source="https://a", score=4.0),
        ],
    )

    def vfn(items):  # nothing verifies
        return [{"index": it["index"], "claim_supported": False, "number_supported": None, "source": None} for it in items]

    _reselect_hook_if_dropped(script, ctx, vfn)
    assert script.beats[0].text == "The Deep Ocean"  # non-asserting fallback = the title


def test_reselect_hook_noop_when_hook_survived():
    ctx = _ctx(("https://a", "A", "s"))
    script = BeatsScript(
        title="T",
        beats=[Beat(text="kept hook", source="https://a"), Beat(text="outro")],
        hook_candidates=[HookCandidate(text="kept hook", source="https://a", score=5.0, chosen=True)],
    )
    calls = {"n": 0}

    def vfn(items):
        calls["n"] += 1
        return []

    _reselect_hook_if_dropped(script, ctx, vfn)
    assert script.beats[0].text == "kept hook"
    assert calls["n"] == 0  # no extra verify call when the hook survived


def test_floor_hard_fails_at_zero_supported_claims():
    script = BeatsScript(title="T", beats=[Beat(text="hook", source="https://a"), Beat(text="outro")])
    with pytest.raises(ValueError):
        _enforce_floor(script)  # 0 body claims → refuse to ship


def test_floor_warns_at_one_without_raising():
    script = BeatsScript(
        title="T",
        beats=[Beat(text="hook", source="https://a"), Beat(text="one fact", source="https://a"), Beat(text="outro")],
    )
    _enforce_floor(script)  # 1 body claim → warns to stderr, does not raise
