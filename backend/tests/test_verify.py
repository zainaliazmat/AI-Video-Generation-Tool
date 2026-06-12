"""Phase 3.3 — claim verification: the hard guarantee that a retrieved snippet
actually SUPPORTS the spoken claim (not just that the cited URL is real).

Per factual beat: spoken-claim-unsupported -> DROP; only-number-unsupported ->
DEMOTE (strip the stat data); supported -> keep. A bounded targeted Tavily lookup
rescues a true fact the broad search missed before any drop. The LLM verifier and
the retrieval are dependency-injected, so these run fully offline."""
from pipeline.verify import verify_script, verify_edited_beats, scaled_max_targeted, EDIT_RECHECK_MAX_TAVILY
from pipeline.content import Beat, BeatsScript
from pipeline.retrieval import RetrievedContext, RetrievedSnippet


def _ctx(*snips):
    return RetrievedContext(
        query="t", snippets=[RetrievedSnippet(title="T", url=u, content=c, score=1.0) for (u, c) in snips]
    )


class _FakeRetrieve:
    """Targeted-lookup stand-in: records calls, returns a fixed context."""

    def __init__(self, ctx):
        self.ctx = ctx
        self.calls = 0
        self.queries = []

    def __call__(self, query, **kw):
        self.calls += 1
        self.queries.append(query)
        return self.ctx


class _FakeVerify:
    """Returns a configured verdict per beat index. `rescue` overrides the verdict
    on the SECOND call for an index (i.e. after a targeted lookup)."""

    def __init__(self, verdicts_by_index, rescue=None):
        self.v = verdicts_by_index
        self.rescue = rescue or {}
        self.seen = {}
        self.batches = 0

    def __call__(self, items):
        self.batches += 1
        out = []
        for it in items:
            i = it["index"]
            self.seen[i] = self.seen.get(i, 0) + 1
            if self.seen[i] >= 2 and i in self.rescue:
                out.append({"index": i, **self.rescue[i]})
            elif i in self.v:
                out.append({"index": i, **self.v[i]})
            # else: omit this verdict → a coverage gap the guard must handle
        return out


def _script(*beats, title="T"):
    return BeatsScript(title=title, beats=list(beats))


def _ok(source="https://a", number=None):
    return dict(claim_supported=True, number_supported=number, source=source)


def _no():
    return dict(claim_supported=False, number_supported=None, source=None)


def test_verify_keeps_supported_claims():
    script = _script(
        Beat(text="hook", source="https://a"),
        Beat(text="The ocean stores carbon.", source="https://a"),
        Beat(text="Follow."),  # non-factual (no source/data) — untouched
    )
    ctx = _ctx(("https://a", "snippet"))
    vf = _FakeVerify({0: _ok(), 1: _ok()})
    out = verify_script(script, ctx, verify_fn=vf, retrieve_fn=_FakeRetrieve(ctx))
    assert [b.text for b in out.beats] == ["hook", "The ocean stores carbon.", "Follow."]


def test_verify_drops_beat_when_spoken_claim_unsupported():
    script = _script(
        Beat(text="hook", source="https://a"),
        Beat(text="Only three people have visited.", source="https://a"),
        Beat(text="Follow."),
    )
    ctx = _ctx(("https://a", "snippet"))
    rt = _FakeRetrieve(_ctx())  # targeted lookup finds nothing
    vf = _FakeVerify({0: _ok(), 1: _no()}, rescue={1: _no()})
    out = verify_script(script, ctx, verify_fn=vf, retrieve_fn=rt)
    assert [b.text for b in out.beats] == ["hook", "Follow."]  # unsupported claim dropped
    assert rt.calls == 1  # but only after a targeted lookup was attempted


def test_verify_targeted_lookup_rescues_true_fact():
    script = _script(Beat(text="hook", source="https://a"), Beat(text="A real but missed fact.", source="https://a"))
    ctx = _ctx(("https://a", "snippet"))
    rt = _FakeRetrieve(_ctx(("https://rescue", "now supported")))
    vf = _FakeVerify({0: _ok(), 1: _no()}, rescue={1: _ok(source="https://rescue")})
    out = verify_script(script, ctx, verify_fn=vf, retrieve_fn=rt)
    assert [b.text for b in out.beats] == ["hook", "A real but missed fact."]  # rescued, not dropped
    assert out.beats[1].source == "https://rescue"  # re-attached from the targeted lookup
    assert rt.calls == 1


def test_verify_demotes_stat_when_only_number_unsupported():
    script = _script(
        Beat(text="hook", source="https://a"),
        Beat(
            text="The ocean stores a lot of carbon.",
            data={"value": "37,700 gigatonnes", "label": "carbon"},
            source="https://a",
        ),
    )
    ctx = _ctx(("https://a", "snippet"))
    vf = _FakeVerify({0: _ok(), 1: _ok(number=False)})  # claim ok, number not supported
    out = verify_script(script, ctx, verify_fn=vf, retrieve_fn=_FakeRetrieve(ctx))
    assert [b.text for b in out.beats] == ["hook", "The ocean stores a lot of carbon."]  # kept
    assert out.beats[1].data is None  # demoted: on-screen number stripped → recipe renders a scene


def test_verify_bounds_targeted_lookups():
    beats = [Beat(text="hook", source="https://a")] + [Beat(text=f"claim {i}", source="https://a") for i in range(5)]
    ctx = _ctx(("https://a", "s"))
    rt = _FakeRetrieve(_ctx())  # never rescues
    verdicts = {0: _ok()}
    rescue = {}
    for i in range(1, 6):
        verdicts[i] = _no()
        rescue[i] = _no()
    vf = _FakeVerify(verdicts, rescue=rescue)
    out = verify_script(_script(*beats), ctx, verify_fn=vf, retrieve_fn=rt, max_targeted=3)
    assert [b.text for b in out.beats] == ["hook"]  # all unsupported claims dropped
    assert rt.calls == 3  # targeted lookups bounded


def test_verify_rescue_is_batched_into_one_recheck():
    beats = [Beat(text="hook", source="https://a")] + [Beat(text=f"c{i}", source="https://a") for i in range(3)]
    ctx = _ctx(("https://a", "s"))
    rt = _FakeRetrieve(_ctx())
    verdicts = {0: _ok()}
    rescue = {}
    for i in range(1, 4):
        verdicts[i] = _no()
        rescue[i] = _no()
    vf = _FakeVerify(verdicts, rescue=rescue)
    verify_script(_script(*beats), ctx, verify_fn=vf, retrieve_fn=rt, max_targeted=3)
    assert vf.batches == 2   # 1 initial verify + 1 BATCHED rescue (not one call per claim)
    assert rt.calls == 3     # but a targeted lookup per rescued claim


def test_verify_coverage_guard_drops_unverified_beat():
    # the verifier returns NO verdict for beat 1 → it must not pass through as verified
    script = _script(Beat(text="hook", source="https://a"), Beat(text="unscored claim", source="https://a"))
    ctx = _ctx(("https://a", "s"))
    rt = _FakeRetrieve(_ctx())  # rescue finds nothing either
    vf = _FakeVerify({0: _ok()})  # no verdict (and no rescue) for index 1
    out = verify_script(script, ctx, verify_fn=vf, retrieve_fn=rt)
    assert [b.text for b in out.beats] == ["hook"]  # default-denied → rescue fails → dropped
    assert rt.calls == 1  # it still got a targeted rescue chance first


def test_verify_records_a_report():
    script = _script(Beat(text="hook", source="https://a"), Beat(text="bad", source="https://a"))
    ctx = _ctx(("https://a", "s"))
    vf = _FakeVerify({0: _ok(), 1: _no()}, rescue={1: _no()})
    out = verify_script(script, ctx, verify_fn=vf, retrieve_fn=_FakeRetrieve(_ctx()))
    verdicts = {r["text"]: r["verdict"] for r in out.verify_report}
    assert verdicts == {"hook": "kept", "bad": "dropped"}


# ---------------------------------------------------------------------------
# v3 M2-T4: named caps — scaled_max_targeted + EDIT_RECHECK_MAX_TAVILY
# ---------------------------------------------------------------------------

class _FakeRetrieveEdited:
    """Targeted-lookup stand-in for verify_edited_beats tests; records call count."""

    def __init__(self):
        self.calls = 0

    def __call__(self, query, *, key=None, cache_dir=None):
        self.calls += 1
        from types import SimpleNamespace
        return SimpleNamespace(snippets=[])


def _always_unsupported(items):
    """verify_fn that marks every item as unsupported."""
    return [
        {"index": it["index"], "claim_supported": False, "number_supported": None, "source": None}
        for it in items
    ]


# ---- scaled_max_targeted formula ----

def test_scaled_max_targeted_8_beats():
    assert scaled_max_targeted(8) == 3   # ceil(8/8)=1 → 3*1=3


def test_scaled_max_targeted_9_beats():
    assert scaled_max_targeted(9) == 6   # ceil(9/8)=2 → 3*2=6


def test_scaled_max_targeted_30_beats():
    assert scaled_max_targeted(30) == 12  # ceil(30/8)=4 → 3*4=12


def test_scaled_max_targeted_48_beats():
    assert scaled_max_targeted(48) == 18  # ceil(48/8)=6 → 3*6=18


# ---- EDIT_RECHECK_MAX_TAVILY cap ----

def test_edit_recheck_cap_fires_exactly_4_retrievals():
    """6 edited indices → only the first 4 trigger Tavily calls; 2 overflow get skip flag."""
    beats = [Beat(text=f"claim {i}", source=f"https://src{i}") for i in range(6)]
    script = BeatsScript(title="T", beats=beats)
    rt = _FakeRetrieveEdited()
    out = verify_edited_beats(script, list(range(6)), verify_fn=_always_unsupported, retrieve_fn=rt)
    assert rt.calls == EDIT_RECHECK_MAX_TAVILY  # exactly 4 Tavily calls fired

    flags_by_idx = {f["index"]: f for f in out.beat_flags}
    assert len(flags_by_idx) == 6

    # Overflow beats (indices 4 and 5) carry the cap-specific skip reason.
    for i in (4, 5):
        assert flags_by_idx[i]["status"] == "unverified"
        assert "recheck skipped (cap)" in flags_by_idx[i]["reason"]
        assert "re-save to recheck" in flags_by_idx[i]["reason"]

    # Checked beats (indices 0-3) carry the normal unsupported reason.
    for i in range(4):
        assert flags_by_idx[i]["status"] == "unverified"
        assert "recheck skipped (cap)" not in flags_by_idx[i]["reason"]


def test_edit_recheck_overflow_beat_order_preserved():
    """Overflow flags are sorted correctly alongside checked flags."""
    beats = [Beat(text=f"c{i}", source="https://s") for i in range(6)]
    script = BeatsScript(title="T", beats=beats)
    rt = _FakeRetrieveEdited()
    out = verify_edited_beats(script, list(range(6)), verify_fn=_always_unsupported, retrieve_fn=rt)
    indices_in_order = [f["index"] for f in out.beat_flags]
    assert indices_in_order == sorted(indices_in_order)


def test_edit_recheck_under_cap_unchanged():
    """4 or fewer edited indices → no overflow, all 4 retrievals fire normally."""
    beats = [Beat(text=f"c{i}", source="https://s") for i in range(4)]
    script = BeatsScript(title="T", beats=beats)
    rt = _FakeRetrieveEdited()
    out = verify_edited_beats(script, [0, 1, 2, 3], verify_fn=_always_unsupported, retrieve_fn=rt)
    assert rt.calls == 4
    assert all(f["status"] == "unverified" for f in out.beat_flags)
    assert all("recheck skipped (cap)" not in (f["reason"] or "") for f in out.beat_flags)
