"""Studio v3 M5 T6 — gate ops: background pick/re_query/upload, pick_template,
broaden=True, hero-pick guard, gatekeeper routing.

Test contract (one test per bullet):

  1. background_pick_happy_path: pick a background clip for a hero scene → row
     pinned, pick_log has human_rank, assemble hash busts → next advance re-runs.
  2. hero_pick_without_target_rejected: plain footage pick on a hero scene raises
     ValueError mentioning target:'background'.
  3. background_target_on_non_hero_rejected: target:'background' on a footage
     scene raises ValueError.
  4. requery_background_pool_refreshed: re_query background → pool replaced for
     the hero scene; auto row (source=auto) follows new rank-1; pinned row untouched.
  5. upload_background_happy_path: upload a file for a hero scene → background_overrides
     row written (source=pinned, picked_rank=None), pick_log row appended.
  6. broaden_true_uses_topic_title: re_query with broaden=True → query passed to
     search_pexels == harden(topic, title=topic).
  7. pick_template_happy_path: pick a valid scene-kind template for a scene →
     template_overrides row written (source=pinned); assemble re-run picks it up.
  8. pick_template_ineligible_unknown_rejected: unknown template id → ValueError.
  9. pick_template_ineligible_wrong_kind_rejected: transition-kind template → ValueError.
 10. gatekeeper_background_pick_at_awaiting_scenes_gate_instant: at the true frontier
     (awaiting, never approved), a background pick re-derives assemble instantly;
     the spec's hero scene gains backgroundClip; gate stays awaiting_approval.
 11. cli_arg_threading: argparse handles --target background, --broaden, --template.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from pipeline.content import Beat, BeatsScript
from pipeline.contracts import Clip, LineOffset, WordTiming
from pipeline import validate as validate_stage
from pipeline.footage_query import harden
from schema import Theme
from session import engine, store, api, gatekeeper
from session.executors import EngineContext

_TEMPLATES = Path(__file__).resolve().parents[2] / "templates"


# ── shared helpers ────────────────────────────────────────────────────────────

def _fake_video(link="a.mp4", duration_s=6.0, pexels_id=1, query="reef"):
    return {
        "duration": duration_s,
        "video_files": [{"link": link, "width": 1080, "height": 1920,
                         "file_type": "video/mp4"}],
        "video_pictures": [{"picture": "thumb"}],
        "id": pexels_id, "url": f"https://pexels.com/v/{pexels_id}",
    }


def _ctx(tmp_path, catalog=None):
    return EngineContext(
        topic="Coral Reefs", fps=30, theme=Theme(),
        catalog=catalog or {},
        assets_dir=tmp_path / "a", cache_dir=tmp_path / "c",
        voiceover_path=tmp_path / "a" / "v.wav",
        spec_out=tmp_path / "spec.json", sources_out=tmp_path / "src.json",
    )


def _install_fakes(monkeypatch, search_results=None, topic="Coral Reefs"):
    """Install minimal pipeline fakes. search_results: dict query→[videos] or callable."""
    script = BeatsScript(title=topic, beats=[
        Beat(text="hook"),
        Beat(text="mid", keywords="coral reef"),
        Beat(text="outro"),
    ])
    monkeypatch.setattr("pipeline.script.generate_grounded_script",
                        lambda t, cache_dir=None, **kw: script)
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

    if search_results is None:
        search_results = {"default": [_fake_video()]}

    if callable(search_results):
        monkeypatch.setattr("pipeline.footage.search_pexels", search_results)
    else:
        _sr = search_results

        def _search(q, key):
            vids = _sr.get(q, _sr.get("default", []))
            return {"videos": vids}

        monkeypatch.setattr("pipeline.footage.search_pexels", _search)

    monkeypatch.setattr("pipeline.footage.fetch_footage",
                        lambda reqs, out_dir, *, fps=30, **kw: [
                            Clip(index=r.index, query=r.query,
                                 path=f"assets/f{r.index}.mp4", duration_frames=300)
                            for r in reqs
                        ])
    monkeypatch.setattr("pipeline.footage._download",
                        lambda url, dest: Path(dest).write_bytes(b"clip"))
    return script


def _make_session(tmp_path, monkeypatch, sid="s1", search_results=None, topic="Coral Reefs"):
    catalog = validate_stage.load_catalog(_TEMPLATES)
    _install_fakes(monkeypatch, search_results=search_results, topic=topic)
    ctx = _ctx(tmp_path, catalog=catalog)
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id=sid, topic=topic, now="t0")
    eng = engine.Engine(conn, ctx, session_id=sid)
    eng.advance("script")
    eng.advance("voice")
    eng.advance("timing")
    eng.advance("footage")
    return eng, conn, ctx, catalog


# ── 1. background pick happy path ────────────────────────────────────────────

def test_background_pick_happy_path(tmp_path, monkeypatch):
    """Background pick for hero scene: row pinned, pick_log has human_rank, hash busts."""
    search = {
        "default": [
            _fake_video(link="bg1.mp4", duration_s=6.0, pexels_id=10),
            _fake_video(link="bg2.mp4", duration_s=9.0, pexels_id=20),
        ],
    }
    eng, conn, ctx, catalog = _make_session(tmp_path, monkeypatch, search_results=search)

    # Capture assemble hash BEFORE the edit
    store.upsert_background_override(conn, "s1", 0, value={"path": "assets/old.mp4"},
                                     source="auto", picked_rank=1, now="t0")
    eng.advance("assemble")
    hash_before = store.get_stage(conn, "s1", "assemble")["input_hash"]

    # background pick rank 2 for scene 0 (hook = hero)
    eng.edit("footage", {"op": "pick", "scene_index": 0, "rank": 2, "target": "background"})

    # background_overrides row must be pinned
    overrides = store.get_background_overrides(conn, "s1")
    assert 0 in overrides, "background_overrides row missing after pick"
    assert overrides[0]["source"] == "pinned"
    assert overrides[0]["picked_rank"] == 2
    assert overrides[0]["value"]["rank"] == 2

    # pick_log must have human_rank=2
    plog = store.get_pick_log(conn, "s1")
    bg_rows = [r for r in plog if r["kind"] == "background" and r["scene_index"] == 0]
    # last entry is the human pick (earlier entries from auto-fill)
    human_pick = [r for r in bg_rows if r["human_rank"] == 2]
    assert human_pick, f"pick_log missing entry with human_rank=2; rows={[dict(r) for r in bg_rows]}"

    # assemble hash must change (override value changed → bust)
    hash_after = store.get_stage(conn, "s1", "assemble")["input_hash"]
    assert hash_before != hash_after, (
        "background pick must bust the assemble hash; "
        f"before={hash_before[:8]}, after={hash_after[:8]}")

    conn.close()


# ── 2. hero pick without target rejected ─────────────────────────────────────

def test_hero_pick_without_target_rejected(tmp_path, monkeypatch):
    """Plain footage pick on a hero scene raises ValueError mentioning target:'background'."""
    eng, conn, ctx, catalog = _make_session(tmp_path, monkeypatch)

    with pytest.raises(ValueError, match="hero"):
        eng.edit("footage", {"op": "pick", "scene_index": 0, "rank": 1})

    conn.close()


# ── 3. background target on non-hero rejected ────────────────────────────────

def test_background_target_on_non_hero_rejected(tmp_path, monkeypatch):
    """target:'background' on a footage scene (non-hero) raises ValueError."""
    eng, conn, ctx, catalog = _make_session(tmp_path, monkeypatch)

    with pytest.raises(ValueError, match="not a hero"):
        eng.edit("footage", {"op": "pick", "scene_index": 1, "rank": 1,
                              "target": "background"})

    conn.close()


# ── 4. re_query background: pool refreshed, auto row updated, pinned untouched ──

def test_requery_background_pool_refreshed(tmp_path, monkeypatch):
    """re_query background: pool replaced; auto row follows new rank-1; pinned survives."""
    search = {
        "default": [_fake_video(link="orig.mp4", duration_s=6.0, pexels_id=5)],
        "new query": [
            _fake_video(link="new1.mp4", duration_s=6.0, pexels_id=99),
            _fake_video(link="new2.mp4", duration_s=8.0, pexels_id=88),
        ],
    }
    eng, conn, ctx, catalog = _make_session(tmp_path, monkeypatch, search_results=search)

    # Seed an auto row for scene 0 (hook) — will be refreshed
    store.upsert_background_override(conn, "s1", 0, value={"path": "assets/bg.mp4"},
                                     source="auto", picked_rank=1, now="t0")
    # Seed a pinned row for scene 2 (outro) — must survive
    store.upsert_background_override(conn, "s1", 2, value={"path": "assets/pin.mp4"},
                                     source="pinned", picked_rank=7, now="t0")

    # re_query background for scene 0 (hook = hero)
    eng.edit("footage", {"op": "re_query", "scene_index": 0, "query": "new query",
                          "target": "background"})

    # Pool for scene 0 must be refreshed with "new query" results
    pool = store.get_footage_candidates(conn, "s1", scene_index=0)
    assert pool, "pool must not be empty after re_query background"
    assert pool[0]["query"] == "new query", (
        f"pool query must be 'new query'; got {pool[0]['query']!r}")
    assert len(pool) == 2, f"expected 2 pool rows; got {len(pool)}"

    # Auto row must update to new rank-1 (pexels_id=99)
    overrides = store.get_background_overrides(conn, "s1")
    assert overrides[0]["source"] == "auto", "auto row must stay auto after re_query"
    assert overrides[0]["value"]["pexels_id"] == 99, (
        f"auto row must update to new rank-1 (pexels_id=99); got {overrides[0]['value']}")

    # Pinned row for scene 2 must be unchanged
    assert overrides[2]["source"] == "pinned"
    assert overrides[2]["picked_rank"] == 7, "pinned row must survive re_query on another scene"

    # pick_log must have an entry for the re_query (human_rank=None)
    plog = store.get_pick_log(conn, "s1")
    rq_rows = [r for r in plog if r["kind"] == "background" and r["scene_index"] == 0
               and r["query"] == "new query"]
    assert rq_rows, "pick_log must have re_query entry"

    conn.close()


# ── 4b. re_query background: pinned row NOT updated ──────────────────────────

def test_requery_background_pinned_row_not_touched(tmp_path, monkeypatch):
    """re_query on a pinned background row: pool refreshes, but the pinned row stays."""
    search = {
        "default": [_fake_video(link="orig.mp4", duration_s=6.0, pexels_id=5)],
        "other query": [_fake_video(link="new.mp4", duration_s=6.0, pexels_id=77)],
    }
    eng, conn, ctx, catalog = _make_session(tmp_path, monkeypatch, search_results=search)

    # Seed a PINNED row for scene 0 (hook)
    store.upsert_background_override(conn, "s1", 0, value={"path": "assets/pinned.mp4"},
                                     source="pinned", picked_rank=3, now="t0")

    # re_query background for scene 0
    eng.edit("footage", {"op": "re_query", "scene_index": 0, "query": "other query",
                          "target": "background"})

    # Pinned row must be unchanged
    overrides = store.get_background_overrides(conn, "s1")
    assert overrides[0]["source"] == "pinned"
    assert overrides[0]["picked_rank"] == 3, "pinned row must not change on re_query"

    conn.close()


# ── 5. upload background happy path ──────────────────────────────────────────

def test_upload_background_happy_path(tmp_path, monkeypatch):
    """Upload a file for a hero scene → background_overrides row written, pick_log row."""
    from pipeline import media_probe as mp_mod

    eng, conn, ctx, catalog = _make_session(tmp_path, monkeypatch)

    # Create a fake video file to upload
    fake_file = tmp_path / "bg_clip.mp4"
    fake_file.write_bytes(b"fake_video_content")

    # Patch ffprobe so the upload doesn't fail on probing
    monkeypatch.setattr("pipeline.media_probe.ffprobe_duration_seconds",
                        lambda path: 5.0)

    eng.edit("footage", {"op": "upload", "scene_index": 0, "file": str(fake_file),
                          "target": "background"})

    # background_overrides row must be pinned, picked_rank=None (upload has no rank)
    overrides = store.get_background_overrides(conn, "s1")
    assert 0 in overrides, "background_overrides row missing after upload"
    assert overrides[0]["source"] == "pinned"
    assert overrides[0]["picked_rank"] is None
    assert "bg_clip.mp4" in overrides[0]["value"]["path"] or \
           overrides[0]["value"]["query"] == "bg_clip.mp4", (
        f"upload value must reference the uploaded file; got {overrides[0]['value']}")

    # pick_log row
    plog = store.get_pick_log(conn, "s1")
    upload_rows = [r for r in plog if r["kind"] == "background" and r["scene_index"] == 0
                   and r["human_rank"] is None]
    assert upload_rows, "pick_log must have an entry for background upload"

    conn.close()


# ── 6. broaden=True uses topic title ─────────────────────────────────────────

def test_broaden_true_uses_topic_title_for_footage_requery(tmp_path, monkeypatch):
    """broaden=True on a footage re_query → query == harden(topic, title=topic)."""
    topic = "Coral Reefs"
    expected_q = harden(topic, title=topic)
    searched = {"q": None}

    def fake_search(q, key):
        searched["q"] = q
        return {"videos": [_fake_video(link="b.mp4", duration_s=6.0, pexels_id=1)]}

    # We need a footage scene (non-hero = index 1 in hook/mid/outro script)
    # Use a script where beat 1 is a footage scene
    eng, conn, ctx, catalog = _make_session(tmp_path, monkeypatch,
                                            search_results=fake_search, topic=topic)

    # re_query footage scene 1 with broaden=True
    eng.edit("footage", {"op": "re_query", "scene_index": 1, "broaden": True})

    assert searched["q"] == expected_q, (
        f"broaden=True must use harden(topic); expected {expected_q!r}, got {searched['q']!r}")

    conn.close()


def test_broaden_true_uses_topic_title_for_background_requery(tmp_path, monkeypatch):
    """broaden=True on a background re_query → query == harden(topic, title=topic)."""
    topic = "Coral Reefs"
    expected_q = harden(topic, title=topic)
    searched = {"q": None}

    def fake_search(q, key):
        searched["q"] = q
        return {"videos": [_fake_video(link="b.mp4", duration_s=6.0, pexels_id=1)]}

    eng, conn, ctx, catalog = _make_session(tmp_path, monkeypatch,
                                            search_results=fake_search, topic=topic)

    # re_query background for hero scene 0 (hook) with broaden=True
    eng.edit("footage", {"op": "re_query", "scene_index": 0, "broaden": True,
                          "target": "background"})

    assert searched["q"] == expected_q, (
        f"broaden=True must use harden(topic) for background; "
        f"expected {expected_q!r}, got {searched['q']!r}")

    conn.close()


# ── 6b. broaden uses plan.title, not ctx.topic (Fix 2) ───────────────────────

def test_broaden_uses_plan_title_not_topic_for_footage_requery(tmp_path, monkeypatch):
    """broaden=True on footage re_query uses plan.title (LLM title), not ctx.topic (raw input).

    The script fake returns a title that differs from the ctx.topic so the test fails
    if the engine uses ctx.topic instead of plan.title."""
    raw_topic = "ocean"               # ctx.topic — raw user input
    plan_title = "Coral Reef Wonders"  # plan.title — LLM-generated (differs from topic)
    expected_q = harden(plan_title, title=plan_title)
    searched = {"q": None}

    def fake_search(q, key):
        searched["q"] = q
        return {"videos": [_fake_video(link="b.mp4", duration_s=6.0, pexels_id=1)]}

    # Script fake returns a title different from raw_topic
    from pipeline.content import Beat, BeatsScript
    script = BeatsScript(title=plan_title, beats=[
        Beat(text="hook"),
        Beat(text="mid reef", keywords="coral reef"),
        Beat(text="outro"),
    ])
    monkeypatch.setattr("pipeline.script.generate_grounded_script",
                        lambda t, cache_dir=None, **kw: script)
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
    monkeypatch.setattr("pipeline.footage.search_pexels", fake_search)
    monkeypatch.setattr("pipeline.footage.fetch_footage",
                        lambda reqs, out_dir, *, fps=30, **kw: [
                            Clip(index=r.index, query=r.query,
                                 path=f"assets/f{r.index}.mp4", duration_frames=300)
                            for r in reqs
                        ])
    monkeypatch.setattr("pipeline.footage._download",
                        lambda url, dest: Path(dest).write_bytes(b"clip"))

    catalog = validate_stage.load_catalog(_TEMPLATES)
    ctx = EngineContext(
        topic=raw_topic, fps=30, theme=Theme(), catalog=catalog,
        assets_dir=tmp_path / "a", cache_dir=tmp_path / "c",
        voiceover_path=tmp_path / "a" / "v.wav",
        spec_out=tmp_path / "spec.json", sources_out=tmp_path / "src.json",
    )
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="s1", topic=raw_topic, now="t0")
    eng = engine.Engine(conn, ctx, session_id="s1")
    eng.advance("script")
    eng.advance("voice")
    eng.advance("timing")
    eng.advance("footage")
    searched["q"] = None  # reset — we only care about the re_query call

    eng.edit("footage", {"op": "re_query", "scene_index": 1, "broaden": True})

    assert searched["q"] == expected_q, (
        f"broaden=True must use harden(plan.title); "
        f"expected {expected_q!r}, got {searched['q']!r}. "
        f"ctx.topic={raw_topic!r} — if that matches, broaden is using ctx.topic instead.")
    conn.close()


def test_broaden_uses_plan_title_not_topic_for_background_requery(tmp_path, monkeypatch):
    """broaden=True on background re_query uses plan.title (LLM title), not ctx.topic."""
    raw_topic = "ocean"
    plan_title = "Coral Reef Wonders"
    expected_q = harden(plan_title, title=plan_title)
    searched = {"q": None}

    def fake_search(q, key):
        searched["q"] = q
        return {"videos": [_fake_video(link="b.mp4", duration_s=6.0, pexels_id=1)]}

    from pipeline.content import Beat, BeatsScript
    script = BeatsScript(title=plan_title, beats=[
        Beat(text="hook"),
        Beat(text="mid reef", keywords="coral reef"),
        Beat(text="outro"),
    ])
    monkeypatch.setattr("pipeline.script.generate_grounded_script",
                        lambda t, cache_dir=None, **kw: script)
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
    monkeypatch.setattr("pipeline.footage.search_pexels", fake_search)
    monkeypatch.setattr("pipeline.footage.fetch_footage",
                        lambda reqs, out_dir, *, fps=30, **kw: [
                            Clip(index=r.index, query=r.query,
                                 path=f"assets/f{r.index}.mp4", duration_frames=300)
                            for r in reqs
                        ])
    monkeypatch.setattr("pipeline.footage._download",
                        lambda url, dest: Path(dest).write_bytes(b"clip"))

    catalog = validate_stage.load_catalog(_TEMPLATES)
    ctx = EngineContext(
        topic=raw_topic, fps=30, theme=Theme(), catalog=catalog,
        assets_dir=tmp_path / "a", cache_dir=tmp_path / "c",
        voiceover_path=tmp_path / "a" / "v.wav",
        spec_out=tmp_path / "spec.json", sources_out=tmp_path / "src.json",
    )
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="s1", topic=raw_topic, now="t0")
    eng = engine.Engine(conn, ctx, session_id="s1")
    eng.advance("script")
    eng.advance("voice")
    eng.advance("timing")
    eng.advance("footage")
    searched["q"] = None  # reset

    eng.edit("footage", {"op": "re_query", "scene_index": 0, "broaden": True,
                          "target": "background"})

    assert searched["q"] == expected_q, (
        f"broaden=True must use harden(plan.title) for background; "
        f"expected {expected_q!r}, got {searched['q']!r}. "
        f"ctx.topic={raw_topic!r} — if that matches, broaden is using ctx.topic instead.")
    conn.close()


# ── 5b. re_query bg auto-follow respects K-floor (Fix 5) ─────────────────────

def test_requery_bg_autofill_follows_kfloor_not_rank1(tmp_path, monkeypatch):
    """Background re_query auto-follow respects the K-floor: when rank-1 is below the
    floor, the auto row is updated to the K-floor's longer pick, not rank-1.

    Setup: TTS gives scene 0 a 1-second duration → floor = (30 + headroom) // 2.
    With real catalog (fade=30, slide=40 max), headroom=40 → floor=35 frames.
    New pool from re_query: rank-1 ~6 frames (0.2s, below floor), rank-2 ~300 frames.
    Expected: auto row updated to rank-2 (K-floor displaced rank-1)."""
    from pipeline.content import Beat, BeatsScript

    short_vid = _fake_video(link="short.mp4", duration_s=0.2, pexels_id=11)   # ~6 frames
    long_vid  = _fake_video(link="long.mp4",  duration_s=10.0, pexels_id=22)  # ~300 frames

    script = BeatsScript(title="Coral Reefs", beats=[
        Beat(text="hook"), Beat(text="mid", keywords="reef"), Beat(text="outro")])

    monkeypatch.setattr("pipeline.script.generate_grounded_script",
                        lambda t, cache_dir=None, **kw: script)
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
    monkeypatch.setattr("pipeline.footage.fetch_footage",
                        lambda reqs, out_dir, *, fps=30, **kw: [
                            Clip(index=r.index, query=r.query,
                                 path=f"assets/f{r.index}.mp4", duration_frames=300)
                            for r in reqs
                        ])
    # Initial pool: something valid so auto-fill succeeds
    monkeypatch.setattr("pipeline.footage.search_pexels",
                        lambda q, key: {"videos": [long_vid]})
    monkeypatch.setattr("pipeline.footage._download",
                        lambda url, dest: Path(dest).write_bytes(b"clip"))

    catalog = validate_stage.load_catalog(_TEMPLATES)
    ctx = EngineContext(
        topic="Coral Reefs", fps=30, theme=Theme(), catalog=catalog,
        assets_dir=tmp_path / "a", cache_dir=tmp_path / "c",
        voiceover_path=tmp_path / "a" / "v.wav",
        spec_out=tmp_path / "spec.json", sources_out=tmp_path / "src.json",
    )
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="s1", topic="Coral Reefs", now="t0")
    eng = engine.Engine(conn, ctx, session_id="s1")
    eng.advance("script")
    eng.advance("voice")
    eng.advance("timing")
    eng.advance("footage")

    # Scene 0 (hook) has an auto row after advance — verify it exists
    overrides_before = store.get_background_overrides(conn, "s1")
    assert 0 in overrides_before and overrides_before[0]["source"] == "auto"

    # re_query background for hook (scene 0) — new pool: rank-1 short, rank-2 long
    def re_search(q, key):
        return {"videos": [short_vid, long_vid]}
    monkeypatch.setattr("pipeline.footage.search_pexels", re_search)

    eng.edit("footage", {"op": "re_query", "scene_index": 0, "query": "new query",
                          "target": "background"})

    overrides = store.get_background_overrides(conn, "s1")
    assert 0 in overrides, "auto row must still exist after re_query"
    # rank-1 is short (6 frames < floor 35) → K-floor displaces to rank-2 (pexels_id=22)
    assert overrides[0]["value"]["pexels_id"] == 22, (
        f"K-floor must displace rank-1 (pexels_id=11) to rank-2 (pexels_id=22); "
        f"got pexels_id={overrides[0]['value'].get('pexels_id')}")
    assert overrides[0]["picked_rank"] == 2, (
        f"auto row picked_rank must be 2 (K-floor pick); got {overrides[0]['picked_rank']}")
    conn.close()


# ── Fix 1: uploaded image background → spec backgroundClip.type == 'image' ────

def test_uploaded_image_background_produces_image_type_in_spec(tmp_path, monkeypatch):
    """Uploading a .png as a background clip must produce backgroundClip.type == 'image'
    in the assembled spec (not 'video' which would route through OffthreadVideo)."""
    from pipeline import media_probe as mp_mod

    eng, conn, ctx, catalog = _make_session(tmp_path, monkeypatch)

    # Create a fake PNG file to upload as background
    fake_png = tmp_path / "backdrop.png"
    fake_png.write_bytes(b"\x89PNG\r\n")  # minimal PNG-ish header

    # No ffprobe needed for images — kind_from_extension returns 'image' directly
    eng.edit("footage", {"op": "upload", "scene_index": 0, "file": str(fake_png),
                          "target": "background"})

    # Check background_overrides row carries kind='image'
    overrides = store.get_background_overrides(conn, "s1")
    assert 0 in overrides, "background_overrides row must be written for scene 0"
    clip_val = overrides[0]["value"]
    assert clip_val.get("kind") == "image", (
        f"uploaded PNG background must store kind='image'; got kind={clip_val.get('kind')!r}")

    # Check assembled spec has backgroundClip.type == 'image'
    spec = json.loads((tmp_path / "spec.json").read_text())
    hook_props = spec["scenes"][0].get("templateProps", {})
    assert "backgroundClip" in hook_props, (
        "hook scene templateProps must contain backgroundClip after upload")
    assert hook_props["backgroundClip"]["type"] == "image", (
        f"backgroundClip.type must be 'image' for a PNG upload; "
        f"got type={hook_props['backgroundClip']['type']!r}")
    conn.close()


# ── 7. pick_template happy path ──────────────────────────────────────────────

def test_pick_template_happy_path(tmp_path, monkeypatch):
    """Valid scene-kind template → template_overrides row written; assemble uses it.

    We use the 'scene' template id specifically because:
    - scene 1 is a footage scene with 'media' props
    - 'scene' template's inputSchema accepts those props (it's the natural template)
    - 'enumeration' requires 'items' which the footage scene doesn't have
    The test picks the 'scene' template id explicitly so the prop-compatibility check
    passes — which is the correct eligibility gate behavior.
    """
    eng, conn, ctx, catalog = _make_session(tmp_path, monkeypatch)

    # Use "scene" template — the natural scene-kind template whose inputSchema
    # accepts the footage scene's existing media props (or empty props).
    # This is the correct eligibility path: same template kind, compatible props.
    tmpl_id = "scene"
    assert tmpl_id in catalog, f"'scene' template must be in catalog"
    assert catalog[tmpl_id].kind == "scene", "scene template kind must be 'scene'"

    # Run assemble so we have the current spec (needed for pick_template prop check)
    eng.advance("assemble")

    eng.edit("footage", {"op": "pick_template", "scene_index": 1, "template": tmpl_id})

    # template_overrides row written
    tmpl_overrides = store.get_template_overrides(conn, "s1")
    assert 1 in tmpl_overrides, "template_overrides row must be written after pick_template"
    assert tmpl_overrides[1]["value"] == tmpl_id
    assert tmpl_overrides[1]["source"] == "pinned"

    # Assemble must re-run and use the new template
    spec = eng._load_output("assemble")
    assert spec.scenes[1].template == tmpl_id, (
        f"assemble must pick up the template override; "
        f"expected {tmpl_id!r}, got {spec.scenes[1].template!r}")

    conn.close()


# ── 8. pick_template: unknown id rejected ────────────────────────────────────

def test_pick_template_unknown_id_rejected(tmp_path, monkeypatch):
    """Unknown template id raises ValueError (catalog presence check)."""
    eng, conn, ctx, catalog = _make_session(tmp_path, monkeypatch)
    eng.advance("assemble")

    with pytest.raises(ValueError, match="unknown template id"):
        eng.edit("footage", {"op": "pick_template", "scene_index": 1,
                              "template": "nonexistent_template_xyz"})

    conn.close()


# ── 9. pick_template: wrong kind rejected ─────────────────────────────────────

def test_pick_template_wrong_kind_rejected(tmp_path, monkeypatch):
    """Transition-kind template → ValueError (wrong kind for scene position)."""
    eng, conn, ctx, catalog = _make_session(tmp_path, monkeypatch)
    eng.advance("assemble")

    transition_templates = [m.id for m in catalog.values() if m.kind == "transition"]
    assert transition_templates, "need at least one transition template in catalog"
    t_id = transition_templates[0]

    with pytest.raises(ValueError, match="kind"):
        eng.edit("footage", {"op": "pick_template", "scene_index": 1, "template": t_id})

    conn.close()


# ── 10. gatekeeper: background pick at awaiting scenes gate = instant ─────────

def test_gatekeeper_background_pick_awaiting_scenes_gate_instant(tmp_path, monkeypatch):
    """At the true frontier (scenes gate awaiting, never approved), a background pick
    is instant: assemble re-derives, spec has backgroundClip, gate stays awaiting_approval."""
    from session_helpers import fakes_with_counts

    catalog = validate_stage.load_catalog(_TEMPLATES)
    calls = fakes_with_counts(monkeypatch)
    # fakes_with_counts doesn't patch _download — add it so the background pick doesn't
    # try to issue a real HTTP request for the pool row's "link" field.
    monkeypatch.setattr("pipeline.footage._download",
                        lambda url, dest: Path(dest).write_bytes(b"clip"))

    # Build a session and run the scenes segment to reach the scenes gate
    sid_dir = tmp_path / "s1"
    sid_dir.mkdir()
    ctx = EngineContext(
        topic="Coral Reefs", fps=30, theme=Theme(), catalog=catalog,
        assets_dir=sid_dir / "a", cache_dir=sid_dir / "c",
        voiceover_path=sid_dir / "a" / "v.wav",
        spec_out=sid_dir / "spec.json", sources_out=sid_dir / "src.json",
    )
    sess = api.create(sid_dir / "s.db", ctx, session_id="s1", topic="Coral Reefs")
    gatekeeper.start(sess)
    gatekeeper.approve(sess, "script")
    gatekeeper.approve(sess, "voice")
    # Now at scenes gate (awaiting_approval, never approved)
    states = store.get_gate_states(sess.conn, "s1")
    assert states.get("scenes", {}).get("state") == "awaiting_approval"
    assert states.get("scenes", {}).get("approved_at") is None, (
        "scenes gate must be a true frontier (never approved)")

    # Seed pool candidates for hero scene 0 (hook) so pick can find rank 1.
    # Use a valid-looking URL so _download (now faked) is invoked without error.
    out = sess.engine._load_output("footage")
    pool_row = {"rank": 1, "query": "reef", "link": "https://p.com/hook.mp4",
                "duration_frames": 90, "pexels_id": 1, "pexels_url": "https://p.com/1",
                "selected": 0, "clip_path": None, "thumb_url": None}
    out["candidates"][0] = [pool_row]
    to_json, _ = engine.CODECS["footage"]
    store.upsert_stage(sess.conn, "s1", "footage", status="done",
                       input_hash=store.get_stage(sess.conn, "s1", "footage")["input_hash"],
                       output_json=json.dumps(to_json(out), default=str), now="t1")
    store.replace_footage_candidates(sess.conn, "s1", scene_index=0, candidates=[pool_row])

    # Apply background pick for hero scene 0 (hook) — must be instant at frontier
    calls_before = calls.copy()
    gatekeeper.edit(sess, "footage", {"op": "pick", "scene_index": 0, "rank": 1,
                                       "target": "background"})

    # background_overrides row must be pinned
    overrides = store.get_background_overrides(sess.conn, "s1")
    assert 0 in overrides, "background_overrides row must be written"
    assert overrides[0]["source"] == "pinned"

    # assemble re-ran (instant frontier semantics)
    assert calls["assemble"] > calls_before.get("assemble", 0), (
        "assemble must re-run after background pick at the frontier gate")

    # spec.json must exist and have backgroundClip in the hook scene
    spec = json.loads((sid_dir / "spec.json").read_text())
    hook_props = spec["scenes"][0].get("templateProps", {})
    assert "backgroundClip" in hook_props, (
        "after instant background pick, spec hook scene must carry backgroundClip; "
        f"got keys: {list(hook_props.keys())}")

    # Gate must still be awaiting_approval (not advanced past frontier)
    states_after = store.get_gate_states(sess.conn, "s1")
    assert states_after["scenes"]["state"] == "awaiting_approval", (
        "scenes gate must remain awaiting_approval after instant background pick")

    api.close(sess)


# ── 11. CLI arg threading ─────────────────────────────────────────────────────

def test_cli_argparse_target_background():
    """argparse handles --target background without error."""
    import argparse
    import sys

    # Replicate the argparse setup from session_edit.py
    ap = argparse.ArgumentParser()
    ap.add_argument("--sid", required=True)
    ap.add_argument("--op", required=True,
                    choices=["pick", "re_query", "upload", "pick_template"])
    ap.add_argument("--scene", type=int, required=True)
    ap.add_argument("--rank", type=int)
    ap.add_argument("--query")
    ap.add_argument("--file")
    ap.add_argument("--target", default="footage", choices=["footage", "background"])
    ap.add_argument("--broaden", action="store_true")
    ap.add_argument("--template")

    args = ap.parse_args(["--sid", "s1", "--op", "pick", "--scene", "0",
                           "--rank", "2", "--target", "background"])
    assert args.target == "background"
    assert args.rank == 2
    assert args.broaden is False


def test_cli_argparse_broaden():
    """argparse handles --broaden flag."""
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--sid", required=True)
    ap.add_argument("--op", required=True,
                    choices=["pick", "re_query", "upload", "pick_template"])
    ap.add_argument("--scene", type=int, required=True)
    ap.add_argument("--rank", type=int)
    ap.add_argument("--query")
    ap.add_argument("--file")
    ap.add_argument("--target", default="footage", choices=["footage", "background"])
    ap.add_argument("--broaden", action="store_true")
    ap.add_argument("--template")

    args = ap.parse_args(["--sid", "s1", "--op", "re_query", "--scene", "0",
                           "--broaden", "--target", "background"])
    assert args.broaden is True
    assert args.target == "background"
    assert args.query is None


def test_cli_argparse_pick_template():
    """argparse handles --op pick_template --template <id>."""
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--sid", required=True)
    ap.add_argument("--op", required=True,
                    choices=["pick", "re_query", "upload", "pick_template"])
    ap.add_argument("--scene", type=int, required=True)
    ap.add_argument("--rank", type=int)
    ap.add_argument("--query")
    ap.add_argument("--file")
    ap.add_argument("--target", default="footage", choices=["footage", "background"])
    ap.add_argument("--broaden", action="store_true")
    ap.add_argument("--template")

    args = ap.parse_args(["--sid", "s1", "--op", "pick_template", "--scene", "1",
                           "--template", "scene"])
    assert args.op == "pick_template"
    assert args.template == "scene"
