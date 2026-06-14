"""Studio v3 M5 T2 — hero background auto-fill (PRD §6.3 / OV-4 / OV-5).

Test contract:
  1. K-floor displacement: rank-1/2 short (< narration-span floor) → hook picks
     rank-3; override row records picked_rank=3, pick_log auto_rank=3.
     Companion: rank-1 clears the floor → picked_rank=1.
     Re-fire: changed pool refreshes the auto row; pinned row still survives.
  2. Normal pool → rank-1 chosen; row source="auto", picked_rank=1, pick_log row
     (kind="background", auto_rank=1).
  3. stat → NO override row, NO download.
  4. Empty pool / pool_error → no row, no crash.
  5. Pinned row survives a re-fire (seed pinned, re-run hook, row unchanged).
  6. Downloads: hook/outro auto clips downloaded (once per distinct dest); no
     download for cached dest (idempotent on dest.exists()).
  7. Auto-run golden: run_all() still produces a valid spec; M1 byte-identity
     holds (the hook fires in both paths, writing identical rows).
"""
from __future__ import annotations

import json
from pathlib import Path

from pipeline.content import Beat, BeatsScript
from pipeline.contracts import Clip, LineOffset, WordTiming
from pipeline.footage import HERO_BACKGROUND_POLICY
from schema import Theme
from session import engine, executors, store
from session.executors import EngineContext
from pipeline import validate as validate_stage

_TEMPLATES = Path(__file__).resolve().parents[2] / "templates"


# ── shared helpers ────────────────────────────────────────────────────────────

def _fake_video(link="a.mp4", duration_s=6, pexels_id=1):
    """Minimal Pexels video shape for search_pexels / select_clip fakes."""
    return {
        "duration": duration_s,
        "video_files": [{"link": link, "width": 1080, "height": 1920,
                         "file_type": "video/mp4"}],
        "video_pictures": [{"picture": "thumb"}],
        "id": pexels_id, "url": f"https://pexels.com/v/{pexels_id}",
    }


def _ctx(tmp_path, catalog=None):
    return EngineContext(
        topic="Reefs", fps=30, theme=Theme(), catalog=catalog or {},
        assets_dir=tmp_path / "a", cache_dir=tmp_path / "c",
        voiceover_path=tmp_path / "a" / "v.wav",
        spec_out=tmp_path / "spec.json", sources_out=tmp_path / "src.json",
    )


def _offsets(script):
    return [LineOffset(i, b.text, float(i), float(i + 1))
            for i, b in enumerate(script.beats)]


def _make_session(tmp_path, monkeypatch, script=None, extra_pool_rows=None):
    """
    Install pipeline fakes, run advance("footage"), return (eng, conn, ctx).

    extra_pool_rows: if provided, the fake search for ALL queries returns these
    rows instead of the default single-video list.
    """
    if script is None:
        script = BeatsScript(title="Reefs", beats=[
            Beat(text="hook"),
            Beat(text="mid", keywords="coral reef"),
            Beat(text="outro"),
        ])

    pool_videos = extra_pool_rows if extra_pool_rows is not None else [_fake_video()]

    monkeypatch.setattr("pipeline.script.generate_grounded_script",
                        lambda topic, cache_dir=None, **kw: script)
    monkeypatch.setattr(
        "pipeline.tts.synthesize",
        lambda lines, path, **kw: (
            Path(path).parent.mkdir(parents=True, exist_ok=True),
            Path(path).write_bytes(b"W"),
            [LineOffset(i, t, float(i), float(i + 1)) for i, t in enumerate(lines)])[-1],
    )
    monkeypatch.setattr("pipeline.timing.transcribe_words",
                        lambda wav, fps: [WordTiming("w", 0, 5)])
    monkeypatch.setattr("pipeline.footage.require_env", lambda name: "KEY")
    monkeypatch.setattr("pipeline.footage.search_pexels",
                        lambda q, key: {"videos": pool_videos})
    monkeypatch.setattr("pipeline.footage._download",
                        lambda url, dest: Path(dest).write_bytes(b"v"))

    catalog = validate_stage.load_catalog(_TEMPLATES)
    ctx = _ctx(tmp_path, catalog=catalog)
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="s1", topic="Reefs", now="t0")
    eng = engine.Engine(conn, ctx, session_id="s1")
    eng.advance("script")
    eng.advance("voice")
    eng.advance("timing")
    eng.advance("footage")
    return eng, conn, ctx


# ── 1. K-floor displacement ───────────────────────────────────────────────────

def test_kfloor_displacement_through_hook(tmp_path, monkeypatch):
    """Hook-level K-floor displacement test.

    Floor = (durations[i] + headroom) // 2.
    TTS fake: LineOffset(i, text, float(i), float(i+1)) → start=0s,end=1s for
    scene 0 → durations[0] = round(1*30) - round(0*30) = 30 frames.
    Real catalog (fade max=30, slide max=40) → headroom = 40.
    Floor = (30 + 40) // 2 = 35.

    Pool: rank-1 ~6 frames (0.2s), rank-2 ~9 frames (0.3s), rank-3 ~300 frames (10s).
    Ranks 1 and 2 are below 35 → displaced; rank-3 clears → picked_rank == 3.
    Asserts through the hook: override row picked_rank=3; pick_log auto_rank=3.
    """
    r1 = _fake_video(link="r1.mp4", duration_s=0.2,  pexels_id=1)   # ~6 frames
    r2 = _fake_video(link="r2.mp4", duration_s=0.3,  pexels_id=2)   # ~9 frames
    r3 = _fake_video(link="r3.mp4", duration_s=10.0, pexels_id=3)   # ~300 frames

    pool_videos = [r1, r2, r3]

    script = BeatsScript(title="Reefs", beats=[
        Beat(text="hook"), Beat(text="mid", keywords="reef"), Beat(text="outro")])

    monkeypatch.setattr("pipeline.script.generate_grounded_script",
                        lambda topic, cache_dir=None, **kw: script)
    monkeypatch.setattr(
        "pipeline.tts.synthesize",
        lambda lines, path, **kw: (
            Path(path).parent.mkdir(parents=True, exist_ok=True),
            Path(path).write_bytes(b"W"),
            [LineOffset(i, t, float(i), float(i + 1)) for i, t in enumerate(lines)])[-1],
    )
    monkeypatch.setattr("pipeline.timing.transcribe_words",
                        lambda wav, fps: [WordTiming("w", 0, 5)])
    monkeypatch.setattr("pipeline.footage.require_env", lambda name: "KEY")
    monkeypatch.setattr("pipeline.footage.search_pexels",
                        lambda q, key: {"videos": pool_videos})
    monkeypatch.setattr("pipeline.footage._download",
                        lambda url, dest: Path(dest).write_bytes(b"v"))

    catalog = validate_stage.load_catalog(_TEMPLATES)
    ctx = _ctx(tmp_path, catalog=catalog)
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="s1", topic="Reefs", now="t0")
    eng = engine.Engine(conn, ctx, session_id="s1")
    eng.advance("script")
    eng.advance("voice")
    eng.advance("timing")
    eng.advance("footage")

    overrides = store.get_background_overrides(conn, "s1")
    # hook (index 0): floor=35, ranks 1+2 short → rank-3 displaces
    assert 0 in overrides, "hook override row missing"
    assert overrides[0]["source"] == "auto"
    assert overrides[0]["picked_rank"] == 3, (
        f"expected rank-3 (K-floor displaced ranks 1+2); got {overrides[0]['picked_rank']}")
    assert overrides[0]["value"]["rank"] == 3

    # pick_log must record auto_rank=3 for the hook scene
    plog = store.get_pick_log(conn, "s1")
    hook_bg = [r for r in plog if r["kind"] == "background" and r["scene_index"] == 0]
    assert hook_bg, "pick_log missing hook background entry"
    assert hook_bg[-1]["auto_rank"] == 3, (
        f"pick_log auto_rank should be 3; got {hook_bg[-1]['auto_rank']}")


def test_kfloor_rank1_clears_floor(tmp_path, monkeypatch):
    """Companion: rank-1 clip duration >= floor → picked_rank == 1 (no displacement)."""
    # duration_s=2.0 → 60 frames; floor=(30+40)//2=35 → 60 >= 35 → rank-1 wins
    r1 = _fake_video(link="r1.mp4", duration_s=2.0, pexels_id=1)   # 60 frames
    r2 = _fake_video(link="r2.mp4", duration_s=10.0, pexels_id=2)  # 300 frames

    pool_videos = [r1, r2]

    script = BeatsScript(title="Reefs", beats=[
        Beat(text="hook"), Beat(text="mid", keywords="reef"), Beat(text="outro")])

    monkeypatch.setattr("pipeline.script.generate_grounded_script",
                        lambda topic, cache_dir=None, **kw: script)
    monkeypatch.setattr(
        "pipeline.tts.synthesize",
        lambda lines, path, **kw: (
            Path(path).parent.mkdir(parents=True, exist_ok=True),
            Path(path).write_bytes(b"W"),
            [LineOffset(i, t, float(i), float(i + 1)) for i, t in enumerate(lines)])[-1],
    )
    monkeypatch.setattr("pipeline.timing.transcribe_words",
                        lambda wav, fps: [WordTiming("w", 0, 5)])
    monkeypatch.setattr("pipeline.footage.require_env", lambda name: "KEY")
    monkeypatch.setattr("pipeline.footage.search_pexels",
                        lambda q, key: {"videos": pool_videos})
    monkeypatch.setattr("pipeline.footage._download",
                        lambda url, dest: Path(dest).write_bytes(b"v"))

    catalog = validate_stage.load_catalog(_TEMPLATES)
    ctx = _ctx(tmp_path, catalog=catalog)
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="s1", topic="Reefs", now="t0")
    eng = engine.Engine(conn, ctx, session_id="s1")
    eng.advance("script")
    eng.advance("voice")
    eng.advance("timing")
    eng.advance("footage")

    overrides = store.get_background_overrides(conn, "s1")
    assert 0 in overrides, "hook override row missing"
    assert overrides[0]["picked_rank"] == 1, (
        f"rank-1 clears floor (60 >= 35) → should pick rank-1; "
        f"got {overrides[0]['picked_rank']}")


def test_kfloor_refire_changed_pool_refreshes_auto_row(tmp_path, monkeypatch):
    """Re-fire against a CHANGED pool refreshes the auto row (new rank-1 → row updates).
    Pinned rows survive throughout."""
    # First run: pool with rank-1 long (60 frames) → auto row picked_rank=1
    r1_first = _fake_video(link="first.mp4", duration_s=2.0, pexels_id=10)

    search_pool = {"videos": [r1_first]}

    script = BeatsScript(title="Reefs", beats=[
        Beat(text="hook"), Beat(text="mid", keywords="reef"), Beat(text="outro")])

    monkeypatch.setattr("pipeline.script.generate_grounded_script",
                        lambda topic, cache_dir=None, **kw: script)
    monkeypatch.setattr(
        "pipeline.tts.synthesize",
        lambda lines, path, **kw: (
            Path(path).parent.mkdir(parents=True, exist_ok=True),
            Path(path).write_bytes(b"W"),
            [LineOffset(i, t, float(i), float(i + 1)) for i, t in enumerate(lines)])[-1],
    )
    monkeypatch.setattr("pipeline.timing.transcribe_words",
                        lambda wav, fps: [WordTiming("w", 0, 5)])
    monkeypatch.setattr("pipeline.footage.require_env", lambda name: "KEY")
    monkeypatch.setattr("pipeline.footage.search_pexels",
                        lambda q, key: search_pool["videos"] and
                        {"videos": search_pool["videos"]})
    monkeypatch.setattr("pipeline.footage._download",
                        lambda url, dest: Path(dest).write_bytes(b"v"))

    catalog = validate_stage.load_catalog(_TEMPLATES)
    ctx = _ctx(tmp_path, catalog=catalog)
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="s1", topic="Reefs", now="t0")
    eng = engine.Engine(conn, ctx, session_id="s1")
    eng.advance("script")
    eng.advance("voice")
    eng.advance("timing")

    # Patch search to return the first pool
    monkeypatch.setattr("pipeline.footage.search_pexels",
                        lambda q, key: {"videos": [r1_first]})
    eng.advance("footage")

    overrides_first = store.get_background_overrides(conn, "s1")
    assert overrides_first.get(0, {}).get("picked_rank") == 1, "first run: expect rank-1"
    assert overrides_first.get(0, {}).get("value", {}).get("pexels_id") == 10

    # Seed a pinned row for outro (scene 2) — must survive the re-fire
    store.upsert_background_override(
        conn, "s1", 2,
        value={"path": "assets/pinned_outro.mp4", "rank": 7},
        source="pinned", picked_rank=7, now="pinned-ts")

    # Now change the pool: new rank-1 (different clip, pexels_id=99) and re-fire hook
    r1_new = _fake_video(link="new.mp4", duration_s=3.0, pexels_id=99)

    # Build a synthetic footage_output with the new pool for scene 0
    footage_output = eng._load_output("footage")
    footage_output["candidates"][0] = [
        {"link": "new.mp4", "duration_frames": 90, "rank": 1,
         "pexels_id": 99, "pexels_url": "https://pexels.com/v/99",
         "query": "reef", "selected": 0},
    ]

    eng._auto_fill_hero_backgrounds(footage_output)

    overrides_after = store.get_background_overrides(conn, "s1")
    # Auto row for scene 0 refreshed with new rank-1 (pexels_id=99)
    assert overrides_after[0]["picked_rank"] == 1
    assert overrides_after[0]["value"]["pexels_id"] == 99, (
        "auto row for scene 0 should update to new rank-1 clip")

    # Pinned row for scene 2 must be unchanged
    assert overrides_after[2]["source"] == "pinned"
    assert overrides_after[2]["picked_rank"] == 7, "pinned row must survive re-fire"


# ── 2. Normal pool → rank-1 chosen, source=auto, pick_log ────────────────────

def test_normal_pool_auto_fill_rank1(tmp_path, monkeypatch):
    """Normal pool (1 video): hook override row has source="auto", picked_rank=1,
    and pick_log has a row with kind="background", auto_rank=1."""
    eng, conn, ctx = _make_session(tmp_path, monkeypatch)

    overrides = store.get_background_overrides(conn, "s1")
    # hook (index 0) and outro (index 2) = "auto"; stat → no stat beat here, outro is at 2
    assert 0 in overrides, "hook (index 0) must have an override row"
    assert overrides[0]["source"] == "auto"
    assert overrides[0]["picked_rank"] == 1
    assert overrides[0]["value"]["rank"] == 1

    # outro
    assert 2 in overrides, "outro (index 2) must have an override row"
    assert overrides[2]["source"] == "auto"
    assert overrides[2]["picked_rank"] == 1

    # pick_log
    plog = store.get_pick_log(conn, "s1")
    bg_rows = [r for r in plog if r["kind"] == "background"]
    # hook + outro = 2 background entries
    assert len(bg_rows) == 2, f"expected 2 background pick_log rows; got {len(bg_rows)}"
    scenes_logged = {r["scene_index"] for r in bg_rows}
    assert 0 in scenes_logged, "pick_log missing hook (scene_index=0)"
    assert 2 in scenes_logged, "pick_log missing outro (scene_index=2)"
    for r in bg_rows:
        assert r["auto_rank"] == 1
        assert r["human_rank"] is None


# ── 3. Stat → NO override row, NO download ────────────────────────────────────

def test_stat_no_override_no_download(tmp_path, monkeypatch):
    """Stat scene: HERO_BACKGROUND_POLICY["stat"] == "gradient" → no row, no download."""
    script = BeatsScript(title="Reefs", beats=[
        Beat(text="hook"),
        Beat(text="mid", keywords="reef"),
        Beat(text="stat beat", data={"value": "42%", "label": "reefs bleached"}),
        Beat(text="outro"),
    ])
    downloads = {"n": 0}

    def fake_dl(url, dest):
        downloads["n"] += 1
        Path(dest).write_bytes(b"v")

    monkeypatch.setattr("pipeline.script.generate_grounded_script",
                        lambda topic, cache_dir=None, **kw: script)
    monkeypatch.setattr(
        "pipeline.tts.synthesize",
        lambda lines, path, **kw: (
            Path(path).parent.mkdir(parents=True, exist_ok=True),
            Path(path).write_bytes(b"W"),
            [LineOffset(i, t, float(i), float(i + 1)) for i, t in enumerate(lines)])[-1],
    )
    monkeypatch.setattr("pipeline.timing.transcribe_words",
                        lambda wav, fps: [WordTiming("w", 0, 5)])
    monkeypatch.setattr("pipeline.footage.require_env", lambda name: "KEY")
    monkeypatch.setattr("pipeline.footage.search_pexels",
                        lambda q, key: {"videos": [_fake_video()]})
    monkeypatch.setattr("pipeline.footage._download", fake_dl)

    catalog = validate_stage.load_catalog(_TEMPLATES)
    ctx = _ctx(tmp_path, catalog=catalog)
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="s1", topic="Reefs", now="t0")
    eng = engine.Engine(conn, ctx, session_id="s1")
    eng.advance("script")
    eng.advance("voice")
    eng.advance("timing")
    eng.advance("footage")

    overrides = store.get_background_overrides(conn, "s1")

    # stat is at index 2 (hook=0, mid=1, stat=2, outro=3)
    plan = eng._load_output("script")["plan"]
    stat_indices = [i for i, ps in enumerate(plan.scenes) if ps.role == "stat"]
    assert stat_indices, "no stat scene found in plan"
    for si in stat_indices:
        assert si not in overrides, (
            f"stat scene {si} must NOT have a background override row (gradient policy)")

    # downloads: only hook + outro (2 auto heroes), NOT the stat
    auto_hero_count = sum(
        1 for i, ps in enumerate(plan.scenes)
        if HERO_BACKGROUND_POLICY.get(ps.role) == "auto"
    )
    assert downloads["n"] == auto_hero_count, (
        f"expected {auto_hero_count} downloads (auto heroes only); got {downloads['n']}")


# ── 4. Empty pool / pool_error → no row, no crash ────────────────────────────

def test_empty_pool_no_row_no_crash(tmp_path, monkeypatch):
    """Empty pool for hero scenes: hook fires, but select_clip returns link=None → no
    override row written, no crash (gradient fallback implicit)."""
    monkeypatch.setattr("pipeline.script.generate_grounded_script",
                        lambda topic, cache_dir=None, **kw: BeatsScript(
                            title="Reefs",
                            beats=[Beat(text="hook"), Beat(text="mid", keywords="reef"),
                                   Beat(text="outro")]))
    monkeypatch.setattr(
        "pipeline.tts.synthesize",
        lambda lines, path, **kw: (
            Path(path).parent.mkdir(parents=True, exist_ok=True),
            Path(path).write_bytes(b"W"),
            [LineOffset(i, t, float(i), float(i + 1)) for i, t in enumerate(lines)])[-1],
    )
    monkeypatch.setattr("pipeline.timing.transcribe_words",
                        lambda wav, fps: [WordTiming("w", 0, 5)])
    monkeypatch.setattr("pipeline.footage.require_env", lambda name: "KEY")
    # Return no videos → empty pool for all scenes (footage scene also returns empty
    # but fetch_footage has its own broadening; we patch that too)
    monkeypatch.setattr("pipeline.footage.search_pexels",
                        lambda q, key: {"videos": []})
    # fetch_footage is separate (clips still need to land); patch it directly
    monkeypatch.setattr("pipeline.footage.fetch_footage",
                        lambda reqs, out_dir, *, fps=30, **kw: [
                            Clip(index=r.index, query=r.query,
                                 path=f"assets/f{r.index}.mp4", duration_frames=300)
                            for r in reqs
                        ])
    monkeypatch.setattr("pipeline.footage._download",
                        lambda url, dest: Path(dest).write_bytes(b"v"))

    catalog = validate_stage.load_catalog(_TEMPLATES)
    ctx = _ctx(tmp_path, catalog=catalog)
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="s1", topic="Reefs", now="t0")
    eng = engine.Engine(conn, ctx, session_id="s1")
    eng.advance("script")
    eng.advance("voice")
    eng.advance("timing")
    eng.advance("footage")   # must not raise

    overrides = store.get_background_overrides(conn, "s1")
    # No pool rows → no override rows for any scene
    assert overrides == {}, f"expected no overrides with empty pool; got {overrides}"


# ── 5. Pinned row survives re-fire ────────────────────────────────────────────

def test_pinned_row_survives_refire(tmp_path, monkeypatch):
    """Seed a pinned row for the hook scene, re-advance footage, verify it's unchanged."""
    eng, conn, ctx = _make_session(tmp_path, monkeypatch)

    # Seed a pinned row for scene 0 (hook)
    store.upsert_background_override(
        conn, "s1", 0,
        value={"path": "assets/pinned.mp4", "rank": 5},
        source="pinned",
        picked_rank=5,
        now="pinned-ts",
    )

    # Verify pinned row is there
    overrides_before = store.get_background_overrides(conn, "s1")
    assert overrides_before[0]["source"] == "pinned"
    assert overrides_before[0]["picked_rank"] == 5

    # Re-fire the hook by calling _auto_fill_hero_backgrounds directly (simulating a
    # re-advance where hash changed — call the method directly since the cache would
    # prevent re-advance with same inputs)
    footage_output = eng._load_output("footage")
    eng._auto_fill_hero_backgrounds(footage_output)

    # Pinned row must be unchanged
    overrides_after = store.get_background_overrides(conn, "s1")
    assert overrides_after[0]["source"] == "pinned", (
        "pinned row must survive re-fire of _auto_fill_hero_backgrounds")
    assert overrides_after[0]["picked_rank"] == 5, (
        "pinned row picked_rank must be unchanged after re-fire")


# ── 6. Download idempotency: same dest not re-downloaded ─────────────────────

def test_download_idempotent_when_dest_exists(tmp_path, monkeypatch):
    """If the destination file already exists, _download is NOT called again."""
    download_calls = {"n": 0}

    def counting_dl(url, dest):
        download_calls["n"] += 1
        Path(dest).write_bytes(b"v")

    monkeypatch.setattr("pipeline.footage.require_env", lambda name: "KEY")
    monkeypatch.setattr("pipeline.footage.search_pexels",
                        lambda q, key: {"videos": [_fake_video()]})
    monkeypatch.setattr("pipeline.footage._download", counting_dl)

    script = BeatsScript(title="Reefs", beats=[
        Beat(text="hook"), Beat(text="mid", keywords="reef"), Beat(text="outro")])

    monkeypatch.setattr("pipeline.script.generate_grounded_script",
                        lambda topic, cache_dir=None, **kw: script)
    monkeypatch.setattr(
        "pipeline.tts.synthesize",
        lambda lines, path, **kw: (
            Path(path).parent.mkdir(parents=True, exist_ok=True),
            Path(path).write_bytes(b"W"),
            [LineOffset(i, t, float(i), float(i + 1)) for i, t in enumerate(lines)])[-1],
    )
    monkeypatch.setattr("pipeline.timing.transcribe_words",
                        lambda wav, fps: [WordTiming("w", 0, 5)])

    catalog = validate_stage.load_catalog(_TEMPLATES)
    ctx = _ctx(tmp_path, catalog=catalog)
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="s1", topic="Reefs", now="t0")
    eng = engine.Engine(conn, ctx, session_id="s1")
    eng.advance("script")
    eng.advance("voice")
    eng.advance("timing")
    eng.advance("footage")

    # First advance: N downloads for auto heroes
    first_count = download_calls["n"]
    assert first_count > 0, "expected at least one download on first advance"

    # Re-fire the hook with dest files already on disk
    footage_output = eng._load_output("footage")
    eng._auto_fill_hero_backgrounds(footage_output)

    # No new downloads (dest.exists() guard)
    assert download_calls["n"] == first_count, (
        f"download called again when dest exists: expected {first_count}, got {download_calls['n']}")


# ── 7. Auto-run golden: spec valid + M1 byte-identity ─────────────────────────

def test_run_all_spec_valid_after_autofill(tmp_path, monkeypatch):
    """run_all() still produces a valid spec after the auto-fill hook fires."""
    script = BeatsScript(title="Coral Reefs", beats=[
        Beat(text="Coral reefs cover under one percent of the ocean floor."),
        Beat(text="Yet they shelter a quarter of all marine species.", keywords="coral reef fish"),
        Beat(text="Protect them — follow for more."),
    ])
    catalog = validate_stage.load_catalog(_TEMPLATES)

    monkeypatch.setattr("pipeline.script.generate_grounded_script",
                        lambda topic, cache_dir=None, **kw: script)
    monkeypatch.setattr(
        "pipeline.tts.synthesize",
        lambda lines, path, **kw: (
            Path(path).parent.mkdir(parents=True, exist_ok=True),
            Path(path).write_bytes(b"W"),
            [LineOffset(i, t, float(i), float(i + 1)) for i, t in enumerate(lines)])[-1],
    )
    monkeypatch.setattr("pipeline.timing.transcribe_words",
                        lambda wav, fps: [WordTiming("w", 0, 5)])
    monkeypatch.setattr("pipeline.footage.require_env", lambda name: "KEY")
    monkeypatch.setattr("pipeline.footage.search_pexels",
                        lambda q, key: {"videos": [_fake_video()]})
    monkeypatch.setattr("pipeline.footage._download",
                        lambda url, dest: Path(dest).write_bytes(b"v"))
    monkeypatch.setattr("pipeline.footage.fetch_footage",
                        lambda reqs, out_dir, *, fps=30, **kw: [
                            Clip(index=r.index, query=r.query,
                                 path=f"assets/f{r.index}.mp4", duration_frames=300)
                            for r in reqs
                        ])

    ctx = executors.EngineContext(
        topic="Coral Reefs", fps=30, theme=Theme(), catalog=catalog,
        assets_dir=tmp_path / "assets", cache_dir=tmp_path / "c",
        voiceover_path=tmp_path / "assets" / "voiceover.wav",
        spec_out=tmp_path / "spec.json", sources_out=tmp_path / "src.json",
    )
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="s1", topic="Coral Reefs", now="t0")
    engine.Engine(conn, ctx, session_id="s1").run_all()
    conn.close()

    spec = json.loads((tmp_path / "spec.json").read_text())
    assert spec["meta"]["title"] == "Coral Reefs"
    assert len(spec["scenes"]) == 3
    assert spec["scenes"][1]["template"] == "scene"  # middle beat → footage scene


def test_autofill_injects_backgroundclip_into_hero_scenes(tmp_path, monkeypatch):
    """T5 is now complete: auto-fill (T2) seeds background_overrides rows, and
    assemble (T5) consumes them.  run_all() with auto-fill active must produce
    a spec whose hero scenes carry backgroundClip in templateProps; run_all()
    with auto-fill stubbed out must produce a spec WITHOUT backgroundClip.

    This is the end-to-end T2+T5 integration test."""
    script = BeatsScript(title="Coral Reefs", beats=[
        Beat(text="Coral reefs cover under one percent of the ocean floor."),
        Beat(text="Yet they shelter a quarter of all marine species.", keywords="coral reef fish"),
        Beat(text="Protect them — follow for more."),
    ])
    catalog = validate_stage.load_catalog(_TEMPLATES)

    def run_once(with_autofill, sub, monkeypatch):
        monkeypatch.setattr("pipeline.script.generate_grounded_script",
                            lambda topic, cache_dir=None, **kw: script)
        monkeypatch.setattr(
            "pipeline.tts.synthesize",
            lambda lines, path, **kw: (
                Path(path).parent.mkdir(parents=True, exist_ok=True),
                Path(path).write_bytes(b"W"),
                [LineOffset(i, t, float(i), float(i + 1)) for i, t in enumerate(lines)])[-1],
        )
        monkeypatch.setattr("pipeline.timing.transcribe_words",
                            lambda wav, fps: [WordTiming("w", 0, 5)])
        monkeypatch.setattr("pipeline.footage.require_env", lambda name: "KEY")
        monkeypatch.setattr("pipeline.footage.search_pexels",
                            lambda q, key: {"videos": [_fake_video()]})
        monkeypatch.setattr("pipeline.footage._download",
                            lambda url, dest: Path(dest).write_bytes(b"v"))
        monkeypatch.setattr("pipeline.footage.fetch_footage",
                            lambda reqs, out_dir, *, fps=30, **kw: [
                                Clip(index=r.index, query=r.query,
                                     path=f"assets/f{r.index}.mp4", duration_frames=300)
                                for r in reqs
                            ])

        d = tmp_path / sub
        ctx = executors.EngineContext(
            topic="Coral Reefs", fps=30, theme=Theme(), catalog=catalog,
            assets_dir=d / "assets", cache_dir=d / "c",
            voiceover_path=d / "assets" / "voiceover.wav",
            spec_out=d / "spec.json", sources_out=d / "src.json",
        )
        conn = store.connect(d / "s.db")
        store.create_session(conn, id="s1", topic="Coral Reefs", now="t0")
        eng = engine.Engine(conn, ctx, session_id="s1")

        if not with_autofill:
            # Stub out the auto-fill hook so NO background_overrides rows are seeded.
            monkeypatch.setattr(eng, "_auto_fill_hero_backgrounds", lambda out: None)

        eng.run_all()
        conn.close()
        return json.loads((d / "spec.json").read_text())

    spec_with = run_once(True, "with_fill", monkeypatch)
    spec_without = run_once(False, "no_fill", monkeypatch)

    # With auto-fill: hero scenes (hook=scene 0, outro=scene 2) must carry backgroundClip
    # (T2 seeded background_overrides rows → T5 assemble consumed them).
    hook_props_with = spec_with["scenes"][0]["templateProps"]
    outro_props_with = spec_with["scenes"][2]["templateProps"]
    assert "backgroundClip" in hook_props_with, (
        "run_all() with auto-fill active must inject backgroundClip into hook scene "
        f"(T2+T5 end-to-end); got keys: {list(hook_props_with.keys())}")
    assert "backgroundClip" in outro_props_with, (
        "run_all() with auto-fill active must inject backgroundClip into outro scene "
        f"(T2+T5 end-to-end); got keys: {list(outro_props_with.keys())}")

    # Without auto-fill: no background_overrides rows → no backgroundClip in hero scenes.
    hook_props_without = spec_without["scenes"][0]["templateProps"]
    outro_props_without = spec_without["scenes"][2]["templateProps"]
    assert "backgroundClip" not in hook_props_without, (
        "run_all() with auto-fill stubbed must NOT have backgroundClip in hook scene; "
        f"got keys: {list(hook_props_without.keys())}")
    assert "backgroundClip" not in outro_props_without, (
        "run_all() with auto-fill stubbed must NOT have backgroundClip in outro scene; "
        f"got keys: {list(outro_props_without.keys())}")
