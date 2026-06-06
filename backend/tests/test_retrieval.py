"""Phase 3 (3.1) — the Tavily retrieval seam: a thin, swappable, cached grounding
source. `search` is dependency-injected (like footage's HTTP seam) so these run
fully offline. Verified Tavily REST shape: results[] of {title,url,content,score}."""
from pipeline.retrieval import retrieve, RetrievedContext


class _FakeSearch:
    """A stand-in for the Tavily HTTP call: returns a fixed raw response and
    records how many times it was called + the params it received."""

    def __init__(self, raw):
        self.raw = raw
        self.calls = 0
        self.params = None
        self.key = None

    def __call__(self, query, key, params):
        self.calls += 1
        self.key = key
        self.params = params
        return self.raw


def _raw(*results):
    return {"results": list(results)}


def _r(url, title="T", content="c", score=1.0):
    return {"url": url, "title": title, "content": content, "score": score}


def test_retrieve_parses_results_into_snippets(tmp_path):
    fake = _FakeSearch(_raw(_r("https://a", title="A", content="alpha"), _r("https://b")))
    ctx = retrieve("topic", key="k", search=fake, cache_dir=tmp_path)
    assert isinstance(ctx, RetrievedContext)
    assert [s.url for s in ctx.snippets] == ["https://a", "https://b"]
    assert ctx.snippets[0].title == "A"
    assert ctx.snippets[0].content == "alpha"


def test_retrieve_exposes_url_set(tmp_path):
    fake = _FakeSearch(_raw(_r("https://a"), _r("https://b")))
    ctx = retrieve("topic", key="k", search=fake, cache_dir=tmp_path)
    assert ctx.urls == {"https://a", "https://b"}


def test_retrieve_skips_results_without_url(tmp_path):
    fake = _FakeSearch(_raw(_r("https://a"), {"title": "no url", "content": "x", "score": 0.1}))
    ctx = retrieve("topic", key="k", search=fake, cache_dir=tmp_path)
    assert [s.url for s in ctx.snippets] == ["https://a"]


def test_retrieve_caches_by_query(tmp_path):
    fake = _FakeSearch(_raw(_r("https://a")))
    retrieve("same topic", key="k", search=fake, cache_dir=tmp_path)
    ctx2 = retrieve("same topic", key="k", search=fake, cache_dir=tmp_path)
    assert fake.calls == 1                       # second call served from cache, no network
    assert ctx2.snippets[0].url == "https://a"   # and still returns the data


def test_retrieve_passes_bounded_params(tmp_path):
    fake = _FakeSearch(_raw())
    retrieve("topic", key="k", search=fake, cache_dir=tmp_path, max_results=6, search_depth="advanced")
    assert fake.params["max_results"] == 6
    assert fake.params["search_depth"] == "advanced"


def test_retrieve_handles_empty_results(tmp_path):
    fake = _FakeSearch(_raw())
    ctx = retrieve("topic", key="k", search=fake, cache_dir=tmp_path)
    assert ctx.snippets == []
    assert ctx.urls == set()


def test_prompt_block_lists_each_source_with_url(tmp_path):
    fake = _FakeSearch(_raw(_r("https://a", title="A", content="alpha fact")))
    ctx = retrieve("t", key="k", search=fake, cache_dir=tmp_path)
    block = ctx.prompt_block()
    assert "https://a" in block
    assert "alpha fact" in block
