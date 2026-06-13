"""Studio v3 M5 T1 — hero query wiring (D4) + pools for all beats + OV-6 honesty.

Test contract:
  1. Keyword-less hero beat gets a pool (query == hardened title).
  2. Hero pool stored in footage_candidates; hero clip NOT downloaded.
  3. Rate-limited response retries: 429 then 200 → pool lands, 2 calls.
  4. Cached query → zero network calls (two scenes same query → one fetch;
     or run twice → second run zero).
  5. Exhaustion (429 always) → pool empty + structured pool_error marker,
     stage completes, downstream still runs (no crash).
  6. v2/autopilot byte-identity: spec.json content unchanged (pools live in
     session-DB + pool_errors sidecar, NOT spec content).
"""
from __future__ import annotations

import json
from pathlib import Path

import requests

from pipeline.content import Beat, BeatsScript
from pipeline.contracts import LineOffset
from pipeline.footage import fetch_pool
from pipeline.footage_query import harden
from pipeline.recipe import plan as recipe_plan
from schema import Theme
from session import executors, store, engine
from session.executors import EngineContext
from pipeline import validate as validate_stage

_TEMPLATES = Path(__file__).resolve().parents[2] / "templates"


# ── helpers ─────────────────────────────────────────────────────────────────

def _fake_video(link="a.mp4", duration=6):
    return {
        "duration": duration,
        "video_files": [{"link": link, "width": 1080, "height": 1920,
                         "file_type": "video/mp4"}],
        "video_pictures": [{"picture": "thumb"}],
        "id": 1, "url": "https://pexels.com/v/1",
    }


def _ctx(tmp_path, catalog=None):
    return EngineContext(
        topic="Reefs", fps=30, theme=Theme(), catalog=catalog or {},
        assets_dir=tmp_path / "a", cache_dir=tmp_path / "c",
        voiceover_path=tmp_path / "a" / "v.wav",
        spec_out=tmp_path / "spec.json", sources_out=tmp_path / "src.json")


def _offsets(script):
    return [LineOffset(i, b.text, float(i), float(i + 1))
            for i, b in enumerate(script.beats)]


# ── 1. Keyword-less hero → pool uses hardened title ──────────────────────────

def test_hero_without_keywords_gets_hardened_title_query():
    """A hook beat with no keywords must carry query == harden(title, title=title)."""
    script = BeatsScript(title="Coral Reefs", beats=[
        Beat(text="hook"), Beat(text="mid", keywords="coral reef"), Beat(text="outro")])
    plan = recipe_plan(script, theme=Theme())
    hook = plan.scenes[0]
    outro = plan.scenes[2]
    expected = harden("Coral Reefs", title="Coral Reefs")
    assert hook.role == "hook" and hook.needs_footage is False
    assert hook.query == expected
    assert outro.role == "outro" and outro.needs_footage is False
    assert outro.query == expected


def test_hero_with_keywords_uses_hardened_keywords():
    """A hook beat WITH keywords uses harden(keywords, title=title) as query."""
    script = BeatsScript(title="Coral Reefs", beats=[
        Beat(text="hook", keywords="ocean floor"), Beat(text="mid"), Beat(text="outro")])
    plan = recipe_plan(script, theme=Theme())
    hook = plan.scenes[0]
    assert hook.query == harden("ocean floor", title="Coral Reefs")


def test_hero_pool_fetched_and_stored_no_download(tmp_path, monkeypatch):
    """Hero pool is stored in candidates; hero clip is NOT downloaded.

    The download fake counts calls — it must be zero for hero (index 0 and 2) scenes.
    """
    script = BeatsScript(title="Reefs", beats=[
        Beat(text="hook"), Beat(text="mid", keywords="coral reef"), Beat(text="outro")])
    plan = recipe_plan(script, theme=Theme())
    offsets = _offsets(script)

    searches = {"n": 0}

    def fake_search(query, key):
        searches["n"] += 1
        return {"videos": [_fake_video()]}

    downloads = {"n": 0}

    def fake_download(url, dest):
        downloads["n"] += 1
        Path(dest).write_bytes(b"v")

    monkeypatch.setattr("pipeline.footage.require_env", lambda name: "KEY")
    monkeypatch.setattr("pipeline.footage.search_pexels", fake_search)
    monkeypatch.setattr("pipeline.footage._download", fake_download)

    ctx = _ctx(tmp_path)
    out = executors.run_footage(ctx, {
        "script": {"script": script, "plan": plan}, "voice": offsets})

    # Hero pools (scene 0 and 2) are stored
    assert 0 in out["candidates"], "hook pool missing"
    assert 2 in out["candidates"], "outro pool missing"
    assert len(out["candidates"][0]) > 0, "hook pool is empty"
    assert len(out["candidates"][2]) > 0, "outro pool is empty"

    # Hero rows: selected == 0 (no clip bound)
    for row in out["candidates"][0]:
        assert row["selected"] == 0, "hero row must not be marked selected"

    # Download only fired for the footage scene (index 1)
    assert downloads["n"] == 1, (
        f"expected 1 download (footage scene only); got {downloads['n']}")

    # Clips list only has the footage scene
    assert len(out["clips"]) == 1
    assert out["clips"][0].index == 1


# ── 3. 429 then 200 → pool lands, 2 calls ───────────────────────────────────

def test_fetch_pool_retries_on_429_and_lands(tmp_path):
    """fetch_pool retries a 429 response; on the second call (200) the pool lands."""
    call_count = {"n": 0}
    slept = {"delays": []}

    class FakeResp:
        def __init__(self, status, data=None):
            self.status_code = status
            self._data = data or {}
            self.headers = {}

        def raise_for_status(self):
            if self.status_code >= 400:
                exc = requests.HTTPError(response=self)
                raise exc

        def json(self):
            return self._data

    def fake_get(url, *, params, headers, timeout):
        call_count["n"] += 1
        if call_count["n"] == 1:
            return FakeResp(429)
        return FakeResp(200, {"videos": [_fake_video("ok.mp4", 6)]})

    def fake_sleep(s):
        slept["delays"].append(s)

    from pipeline import footage as footage_mod
    # Inject _get/_sleep through search_pexels's injectable seam
    def fake_search(query, key):
        return footage_mod.search_pexels(query, key, _get=fake_get, _sleep=fake_sleep)

    result = fetch_pool("coral reef", "KEY", 30, cache_dir=tmp_path / "c",
                        search=fake_search)
    assert result["error"] is None, f"expected no error; got {result['error']}"
    assert len(result["rows"]) == 1
    assert call_count["n"] == 2      # 1 × 429, 1 × 200
    assert len(slept["delays"]) == 1  # backed off once


# ── 4. Cache: same query → zero network calls on second run ─────────────────

def test_fetch_pool_caches_by_query(tmp_path):
    """Same hardened query fetched twice: only one network call (second is cache hit)."""
    calls = {"n": 0}

    def fake_search(query, key):
        calls["n"] += 1
        return {"videos": [_fake_video()]}

    cache_dir = tmp_path / "c"
    fetch_pool("coral reef", "KEY", 30, cache_dir=cache_dir, search=fake_search)
    fetch_pool("coral reef", "KEY", 30, cache_dir=cache_dir, search=fake_search)

    assert calls["n"] == 1, (
        f"expected 1 network call (second is cache hit); got {calls['n']}")


def test_two_scenes_same_query_one_fetch(tmp_path):
    """Two scenes sharing the same hardened query → only one pool network call.

    Uses fetch_pool directly with a cache_dir — the second call for the same
    query hits the cache and issues zero network calls.
    """
    calls = {"n": 0}

    def fake_search(query, key):
        calls["n"] += 1
        return {"videos": [_fake_video()]}

    script = BeatsScript(title="Reefs", beats=[
        Beat(text="hook"), Beat(text="mid", keywords="coral reef"), Beat(text="outro")])
    plan = recipe_plan(script, theme=Theme())

    # Verify hook and outro share the same hardened query (both fall back to title)
    hook_q = plan.scenes[0].query
    outro_q = plan.scenes[2].query
    assert hook_q == outro_q, "hook and outro must share the same query for this test"

    cache_dir = tmp_path / "c"

    # First fetch for the shared query — one network call
    fetch_pool(hook_q, "KEY", 30, cache_dir=cache_dir, search=fake_search)
    assert calls["n"] == 1

    # Second fetch (outro's identical query) — cache hit, zero additional calls
    fetch_pool(outro_q, "KEY", 30, cache_dir=cache_dir, search=fake_search)
    assert calls["n"] == 1, (
        f"expected 1 total call (cache hit on second); got {calls['n']}")


# ── 5. Total 429 exhaustion → pool_error marker, stage completes ─────────────

def test_fetch_pool_exhaustion_records_rate_limited_marker(tmp_path):
    """When all retries are 429, fetch_pool returns pool=[] + error='rate_limited'."""
    class FakeResp:
        status_code = 429
        headers = {}

        def raise_for_status(self):
            exc = requests.HTTPError(response=self)
            raise exc

    def always_429(query, key, *, _get=None, _sleep=None, max_retries=3):
        from pipeline import footage as footage_mod
        return footage_mod.search_pexels(
            query, key,
            _get=lambda *a, **kw: FakeResp(),
            _sleep=lambda s: None,
            max_retries=0,   # single attempt → immediate raise
        )

    result = fetch_pool("coral reef", "KEY", 30, cache_dir=tmp_path / "c",
                        search=always_429)
    assert result["rows"] == []
    assert result["error"] == "rate_limited"


def test_run_footage_exhaustion_stage_completes_downstream_ok(tmp_path, monkeypatch):
    """Even when every pool fetch 429-exhausts, run_footage completes and the
    downstream assemble stage still produces a valid spec (pool_errors are advisory,
    never a render blocker).

    Monkeypatches fetch_pool directly so fetch_footage's own search (for the
    footage-scene clip download) continues to work — the two are separate seams.
    """
    script = BeatsScript(title="Reefs", beats=[
        Beat(text="hook"), Beat(text="mid", keywords="coral reef"), Beat(text="outro")])
    plan = recipe_plan(script, theme=Theme())

    # fetch_pool always returns rate_limited — no real network call
    def pool_rate_limited(query, key, fps, *, cache_dir=None, search=None):
        return {"rows": [], "error": "rate_limited"}

    monkeypatch.setattr("pipeline.footage.require_env", lambda name: "KEY")
    monkeypatch.setattr("pipeline.footage.fetch_pool", pool_rate_limited)
    monkeypatch.setattr("pipeline.footage.search_pexels",
                        lambda q, key: {"videos": [_fake_video()]})
    monkeypatch.setattr("pipeline.footage._download",
                        lambda url, dest: Path(dest).write_bytes(b"v"))

    ctx = _ctx(tmp_path)
    out = executors.run_footage(ctx, {
        "script": {"script": script, "plan": plan}, "voice": _offsets(script)})

    # Stage completed and returned clips (footage scene still downloaded)
    assert "clips" in out and len(out["clips"]) == 1

    # pool_errors present for every scene that has a query (hook=0, mid=1, outro=2)
    pe = out.get("pool_errors", {})
    assert pe.get(0) == "rate_limited", f"hook pool_error wrong: {pe}"
    assert pe.get(1) == "rate_limited", f"mid pool_error wrong: {pe}"
    assert pe.get(2) == "rate_limited", f"outro pool_error wrong: {pe}"

    # candidates are all empty lists (pool fetch failed), NOT crash
    for i in (0, 1, 2):
        assert out["candidates"].get(i, []) == []


# ── 6. v2/autopilot byte-identity: pools don't touch spec.json ───────────────

def test_autopilot_spec_unaffected_by_hero_pools(tmp_path, monkeypatch):
    """Hero pools are stored in session-DB / pool_errors — spec.json content must
    be identical whether pools are present or empty (golden autopilot contract).

    Monkeypatches fetch_pool (not search_pexels) so fetch_footage's own search
    for the footage-scene clip download is unaffected in both variants.
    """
    script = BeatsScript(title="Coral Reefs", beats=[
        Beat(text="Coral reefs cover under one percent of the ocean floor."),
        Beat(text="Yet they shelter a quarter of all marine species.", keywords="coral reef fish"),
        Beat(text="Protect them — follow for more."),
    ])

    catalog = validate_stage.load_catalog(_TEMPLATES)

    def run_once(fake_pool, sub):
        monkeypatch.setattr("pipeline.script.generate_grounded_script",
                            lambda topic, cache_dir=None, **kw: script)
        monkeypatch.setattr("pipeline.tts.synthesize",
                            lambda lines, path, **kw: (
                                Path(path).parent.mkdir(parents=True, exist_ok=True),
                                Path(path).write_bytes(b"W"),
                                [LineOffset(i, t, float(i), float(i + 1))
                                 for i, t in enumerate(lines)])[-1])
        from pipeline.contracts import WordTiming
        monkeypatch.setattr("pipeline.timing.transcribe_words",
                            lambda wav, fps: [WordTiming("w", 0, 5)])
        monkeypatch.setattr("pipeline.footage.require_env", lambda name: "KEY")
        # fetch_pool is the pool-only seam; search_pexels drives the clip download
        monkeypatch.setattr("pipeline.footage.fetch_pool", fake_pool)
        monkeypatch.setattr("pipeline.footage.search_pexels",
                            lambda q, key: {"videos": [_fake_video()]})
        monkeypatch.setattr("pipeline.footage._download",
                            lambda url, dest: Path(dest).write_bytes(b"v"))

        d = tmp_path / sub
        ctx = EngineContext(
            topic="Coral Reefs", fps=30, theme=Theme(), catalog=catalog,
            assets_dir=d / "assets", cache_dir=d / "c",
            voiceover_path=d / "assets" / "voiceover.wav",
            spec_out=d / "spec.json", sources_out=d / "src.json")
        conn = store.connect(d / "s.db")
        store.create_session(conn, id="s1", topic="Coral Reefs", now="t0")
        engine.Engine(conn, ctx, session_id="s1").run_all()
        conn.close()
        return (d / "spec.json").read_text()

    # With pools: fetch_pool returns real rows
    def with_pool(query, key, fps, *, cache_dir=None, search=None):
        return {"rows": [{"rank": 1, "query": query, "duration_frames": 180,
                          "thumb_url": "t", "link": "a.mp4",
                          "pexels_id": 1, "pexels_url": "https://p.com/1"}],
                "error": None}

    # Without pools: fetch_pool returns empty (rate_limited)
    def no_pool(query, key, fps, *, cache_dir=None, search=None):
        return {"rows": [], "error": "rate_limited"}

    spec_with = run_once(with_pool, "with_pool")
    spec_without = run_once(no_pool, "no_pool")

    assert json.loads(spec_with) == json.loads(spec_without), (
        "spec.json content changed when pools are present vs absent — "
        "pools must NOT touch the render contract")
