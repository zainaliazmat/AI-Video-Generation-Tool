"""Studio v3 M5 T7 — eligibility + state surface.

Test contract:
  1. eligible_templates: stat props ({value, label}) → stat + other value+label templates
     eligible; enumeration NOT eligible (needs items, not value/label).
  2. eligible_templates: enumeration props ({items: [...]}) → enumeration eligible;
     stat NOT eligible (needs value+label).
  3. eligible_templates: hero props ({title: "..."}) → hook + outro eligible (both
     need only title); stat + enumeration NOT eligible.
  4. eligible_templates: scene props ({media: {...}}) → scene eligible; hero templates
     (hook/outro/stat) need title/value+label → NOT eligible for a media-only prop.
  5. eligible_templates: empty props ({}) → only templates with no required fields
     eligible; stat/enumeration/scene all have required fields → not eligible.
  6. eligible_templates: transition/overlay templates NEVER returned regardless of props.

  State surface (build_state):
  7. Gated session past the scenes gate: every scene carries the five new keys
     (eligibleTemplates, templateOverride, backgroundPool, backgroundProvenance,
     pickLogCount); legacy keys (candidates, provenance, needsFootage, ...) intact.
  8. Enumeration scene: eligibleTemplates includes 'enumeration'; stat scene:
     includes 'stat'.
  9. Hero scene backgroundPool is non-empty (rows from the pool); backgroundProvenance
     comes from background_overrides (auto row from _auto_fill_hero_backgrounds).
 10. pickLogCount + lastPick after a background pick on a hero scene.
 11. templateOverride present (non-null) when a template_override row exists.
 12. poolError marker in backgroundPool when pool_errors set for a scene.
 13. Legacy/ungated session: new keys present with empty/null values (consistent shape).
 14. Pre-spec partial payload: new keys absent from scenes (scenes=[]).
 15. Existing test compatibility: candidates + provenance shape unchanged.
"""
from __future__ import annotations

import json
from pathlib import Path

from pipeline.content import Beat, BeatsScript
from pipeline.contracts import Clip, LineOffset, WordTiming
from pipeline import validate as validate_stage
from pipeline import projects as projects_mod
from pipeline.eligibility import eligible_templates
from session import store, engine
from session.executors import EngineContext
from schema import Theme

_TEMPLATES = Path(__file__).resolve().parents[2] / "templates"


# ── helpers ───────────────────────────────────────────────────────────────────

def _fake_video(link="a.mp4", duration_s=6.0, pexels_id=1):
    return {
        "duration": duration_s,
        "video_files": [{"link": link, "width": 1080, "height": 1920,
                         "file_type": "video/mp4"}],
        "video_pictures": [{"picture": "thumb"}],
        "id": pexels_id, "url": f"https://pexels.com/v/{pexels_id}",
    }


def _ctx(tmp_path, sid, catalog=None):
    sid_dir = tmp_path / "projects" / sid
    sid_dir.mkdir(parents=True, exist_ok=True)
    cat = catalog or validate_stage.load_catalog(_TEMPLATES)
    return EngineContext(
        topic="Reefs", fps=30, theme=Theme(), catalog=cat,
        assets_dir=tmp_path / "a", cache_dir=tmp_path / "c",
        voiceover_path=tmp_path / "a" / projects_mod.voiceover_name(sid),
        spec_out=sid_dir / "spec.json",
        sources_out=sid_dir / "sources.json",
    )


def _install_fakes(monkeypatch, script, search_fn=None):
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
    if search_fn is None:
        monkeypatch.setattr("pipeline.footage.search_pexels",
                            lambda q, key: {"videos": [_fake_video()]})
    else:
        monkeypatch.setattr("pipeline.footage.search_pexels", search_fn)
    monkeypatch.setattr("pipeline.footage._download",
                        lambda url, dest: Path(dest).write_bytes(b"clip"))
    monkeypatch.setattr(
        "pipeline.footage.fetch_footage",
        lambda reqs, out_dir, *, fps=30, **kw: [
            Clip(index=r.index, query=r.query,
                 path=f"assets/f{r.index}.mp4", duration_frames=300)
            for r in reqs
        ],
    )


def _seed_session(tmp_path, monkeypatch, sid, script):
    """Run a full session to completion; returns (conn, ctx)."""
    catalog = validate_stage.load_catalog(_TEMPLATES)
    _install_fakes(monkeypatch, script)
    ctx = _ctx(tmp_path, sid, catalog=catalog)
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id=sid, topic="Reefs", now="t0")
    eng = engine.Engine(conn, ctx, session_id=sid)
    eng.run_all()
    return conn, ctx


def _build_state(tmp_path, monkeypatch, sid):
    """Invoke build_state with the test DB / REPO_ROOT."""
    import session_state as ss
    monkeypatch.setattr("session.job_ctx.SESSIONS_DB", tmp_path / "s.db")
    monkeypatch.setattr("session.job_ctx.REPO_ROOT", tmp_path)
    monkeypatch.setattr("session.job_ctx.TEMPLATES_DIR", _TEMPLATES)
    return ss.build_state(sid)


# ══════════════════════════════════════════════════════════════════════════════
# 1–6: eligible_templates unit tests (pure, no DB)
# ══════════════════════════════════════════════════════════════════════════════

def test_eligible_templates_stat_props():
    """stat props {value, label} → 'stat' eligible; 'enumeration' not (needs items)."""
    catalog = validate_stage.load_catalog(_TEMPLATES)
    result = eligible_templates({"value": "42%", "label": "of reefs bleached"}, catalog)
    assert "stat" in result
    assert "enumeration" not in result


def test_eligible_templates_enumeration_props():
    """enumeration props {items: [...]} → 'enumeration' eligible; 'stat' not."""
    catalog = validate_stage.load_catalog(_TEMPLATES)
    result = eligible_templates({"items": ["Sun", "Moon", "Stars"]}, catalog)
    assert "enumeration" in result
    assert "stat" not in result


def test_eligible_templates_hero_props():
    """hook/outro props {title: ...} → 'hook' and 'outro' both eligible (both need only title)."""
    catalog = validate_stage.load_catalog(_TEMPLATES)
    result = eligible_templates({"title": "Oceans cover 71% of Earth"}, catalog)
    assert "hook" in result
    assert "outro" in result
    # stat needs value+label; enumeration needs items — not in these props
    assert "stat" not in result
    assert "enumeration" not in result


def test_eligible_templates_scene_props():
    """scene (footage) props {media: {type, src, fit}} → 'scene' eligible;
    hero templates needing title/value+label → not eligible."""
    catalog = validate_stage.load_catalog(_TEMPLATES)
    result = eligible_templates(
        {"media": {"type": "video", "src": "assets/f1.mp4", "fit": "cover"}}, catalog)
    assert "scene" in result
    assert "hook" not in result
    assert "stat" not in result


def test_eligible_templates_empty_props():
    """Empty props {} → only templates with no required fields eligible.
    All core templates have required fields — none should be eligible."""
    catalog = validate_stage.load_catalog(_TEMPLATES)
    result = eligible_templates({}, catalog)
    # All core scene templates require at least one field; none pass against {}
    core_scene_templates = {"hook", "scene", "stat", "outro", "enumeration"}
    overlap = set(result) & core_scene_templates
    assert overlap == set(), f"unexpected core templates eligible for empty props: {overlap}"


def test_eligible_templates_excludes_transition_overlay():
    """Transition and overlay templates MUST NOT appear regardless of props."""
    catalog = validate_stage.load_catalog(_TEMPLATES)
    # Use props that might accidentally match if kind-gating were absent
    result_set = set(eligible_templates({}, catalog))
    for tmpl_id, manifest in catalog.items():
        if manifest.kind in ("transition", "overlay"):
            assert tmpl_id not in result_set, (
                f"transition/overlay template {tmpl_id!r} leaked into eligible set")


# ══════════════════════════════════════════════════════════════════════════════
# 7–15: state surface integration tests
# ══════════════════════════════════════════════════════════════════════════════

def test_state_five_new_keys_present_on_every_scene(tmp_path, monkeypatch):
    """Every scene in a post-spec session carries the five new T7 keys."""
    script = BeatsScript(title="Reefs", beats=[
        Beat(text="hook"),
        Beat(text="mid", keywords="coral reef"),
        Beat(text="outro"),
    ])
    sid = "t7-s1"
    conn, ctx = _seed_session(tmp_path, monkeypatch, sid, script)
    conn.close()

    state = _build_state(tmp_path, monkeypatch, sid)
    assert len(state["scenes"]) > 0
    for sc in state["scenes"]:
        assert "eligibleTemplates" in sc, f"missing eligibleTemplates at scene {sc['index']}"
        assert "templateOverride" in sc, f"missing templateOverride at scene {sc['index']}"
        assert "backgroundPool" in sc, f"missing backgroundPool at scene {sc['index']}"
        assert "backgroundProvenance" in sc, f"missing backgroundProvenance at scene {sc['index']}"
        assert "pickLogCount" in sc, f"missing pickLogCount at scene {sc['index']}"


def test_state_eligible_templates_stat_scene(tmp_path, monkeypatch):
    """Stat beat: eligibleTemplates includes 'stat'."""
    script = BeatsScript(title="Reefs", beats=[
        Beat(text="hook"),
        Beat(text="42% bleached", data={"value": "42%", "label": "of reefs bleached"}),
        Beat(text="outro"),
    ])
    sid = "t7-stat"
    conn, ctx = _seed_session(tmp_path, monkeypatch, sid, script)
    conn.close()

    state = _build_state(tmp_path, monkeypatch, sid)
    # scene index 1 is the stat beat
    stat_scene = next(s for s in state["scenes"] if s["index"] == 1)
    assert "stat" in stat_scene["eligibleTemplates"], (
        f"'stat' not in eligible: {stat_scene['eligibleTemplates']}")


def test_state_eligible_templates_enumeration_scene(tmp_path, monkeypatch):
    """Enumeration beat: eligibleTemplates includes 'enumeration'."""
    catalog = validate_stage.load_catalog(_TEMPLATES)
    script = BeatsScript(title="Reefs", beats=[
        Beat(text="hook"),
        Beat(text="key items", data={"items": ["Coral", "Fish", "Seagrass"]}),
        Beat(text="outro"),
    ])
    sid = "t7-enum"
    _install_fakes(monkeypatch, script)
    ctx = _ctx(tmp_path, sid, catalog=catalog)
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id=sid, topic="Reefs", now="t0")
    eng = engine.Engine(conn, ctx, session_id=sid)
    eng.run_all()
    conn.close()

    state = _build_state(tmp_path, monkeypatch, sid)
    enum_scene = next(s for s in state["scenes"] if s["index"] == 1)
    assert "enumeration" in enum_scene["eligibleTemplates"], (
        f"'enumeration' not in eligible: {enum_scene['eligibleTemplates']}")
    # stat NOT eligible (no value+label in enumeration props)
    assert "stat" not in enum_scene["eligibleTemplates"]


def test_state_hero_background_pool_non_empty(tmp_path, monkeypatch):
    """Hero scene (hook at index 0) has backgroundPool.rows non-empty
    after footage runs (auto-fill fetches and stores the pool)."""
    script = BeatsScript(title="Reefs", beats=[
        Beat(text="hook"),
        Beat(text="mid", keywords="coral reef"),
        Beat(text="outro"),
    ])
    sid = "t7-bgpool"
    conn, ctx = _seed_session(tmp_path, monkeypatch, sid, script)
    conn.close()

    state = _build_state(tmp_path, monkeypatch, sid)
    hook_scene = next(s for s in state["scenes"] if s["index"] == 0)
    bg_pool = hook_scene["backgroundPool"]
    assert isinstance(bg_pool, dict), "backgroundPool must be a dict"
    assert "rows" in bg_pool, "backgroundPool missing 'rows'"
    assert "poolError" in bg_pool, "backgroundPool missing 'poolError'"
    # pool was fetched (fakes return one video)
    assert len(bg_pool["rows"]) > 0, "hook backgroundPool.rows is empty"
    assert bg_pool["poolError"] is None  # no rate-limit in this run


def test_state_hero_background_provenance_from_override(tmp_path, monkeypatch):
    """backgroundProvenance for hook comes from background_overrides (auto row
    written by _auto_fill_hero_backgrounds), not media_provenance."""
    script = BeatsScript(title="Reefs", beats=[
        Beat(text="hook"),
        Beat(text="mid", keywords="coral reef"),
        Beat(text="outro"),
    ])
    sid = "t7-bgprov"
    conn, ctx = _seed_session(tmp_path, monkeypatch, sid, script)
    conn.close()

    state = _build_state(tmp_path, monkeypatch, sid)
    hook_scene = next(s for s in state["scenes"] if s["index"] == 0)
    prov = hook_scene["backgroundProvenance"]
    # auto-fill should have written a background_overrides row
    assert prov is not None, "backgroundProvenance should not be null after auto-fill"
    assert prov["source"] == "auto"
    assert "pickedRank" in prov
    assert "updatedAt" in prov


def test_state_pick_log_count_and_last_pick(tmp_path, monkeypatch):
    """pickLogCount + lastPick reflect pick_log rows after a background pick."""
    script = BeatsScript(title="Reefs", beats=[
        Beat(text="hook"),
        Beat(text="mid", keywords="coral reef"),
        Beat(text="outro"),
    ])
    sid = "t7-picklg"
    conn, ctx = _seed_session(tmp_path, monkeypatch, sid, script)

    # Manually append a background pick log entry (simulating a human pick)
    store.append_pick_log(conn, sid, scene_index=0, kind="background",
                          query="reef", auto_rank=1, human_rank=2, ts="ts1")
    conn.close()

    state = _build_state(tmp_path, monkeypatch, sid)
    hook_scene = next(s for s in state["scenes"] if s["index"] == 0)

    # auto-fill wrote one row during footage; we added one more → count >= 2
    assert hook_scene["pickLogCount"] >= 2, (
        f"expected >= 2 pick_log entries; got {hook_scene['pickLogCount']}")
    last = hook_scene["lastPick"]
    assert last is not None
    assert last["humanRank"] == 2
    assert last["autoRank"] == 1


def test_state_template_override_present(tmp_path, monkeypatch):
    """templateOverride is non-null when a template_overrides row exists."""
    script = BeatsScript(title="Reefs", beats=[
        Beat(text="hook"),
        Beat(text="mid", keywords="coral reef"),
        Beat(text="outro"),
    ])
    sid = "t7-tov"
    conn, ctx = _seed_session(tmp_path, monkeypatch, sid, script)

    # Write a pinned template override for the footage scene (index 1)
    store.upsert_template_override(conn, sid, 1,
                                   value="scene", source="pinned",
                                   picked_rank=None, now="ts-tov")
    conn.close()

    state = _build_state(tmp_path, monkeypatch, sid)
    mid_scene = next(s for s in state["scenes"] if s["index"] == 1)
    tov = mid_scene["templateOverride"]
    assert tov is not None, "templateOverride must be non-null when row exists"
    assert tov["value"] == "scene"
    assert tov["source"] == "pinned"
    assert tov["pickedRank"] is None


def test_state_pool_error_marker_in_background_pool(tmp_path, monkeypatch):
    """When footage stage records a pool_error for a scene, backgroundPool.poolError
    reflects it."""
    script = BeatsScript(title="Reefs", beats=[
        Beat(text="hook"),
        Beat(text="mid", keywords="coral reef"),
        Beat(text="outro"),
    ])
    sid = "t7-poole"
    catalog = validate_stage.load_catalog(_TEMPLATES)
    _install_fakes(monkeypatch, script)
    ctx = _ctx(tmp_path, sid, catalog=catalog)
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id=sid, topic="Reefs", now="t0")
    eng = engine.Engine(conn, ctx, session_id=sid)
    eng.run_all()

    # Overwrite the footage stage output to inject a pool_error for scene 0
    footage_row = store.get_stage(conn, sid, "footage")
    footage_json = json.loads(footage_row["output_json"])
    footage_json.setdefault("pool_errors", {})["0"] = "rate_limited"
    store.upsert_stage(conn, sid, "footage", status="done",
                       input_hash=footage_row["input_hash"],
                       output_json=json.dumps(footage_json), now="t1")
    conn.close()

    state = _build_state(tmp_path, monkeypatch, sid)
    hook_scene = next(s for s in state["scenes"] if s["index"] == 0)
    assert hook_scene["backgroundPool"]["poolError"] == "rate_limited"


def test_state_template_override_null_when_no_row(tmp_path, monkeypatch):
    """templateOverride is null (None) when no template_overrides row exists."""
    script = BeatsScript(title="Reefs", beats=[
        Beat(text="hook"),
        Beat(text="mid", keywords="coral reef"),
        Beat(text="outro"),
    ])
    sid = "t7-novr"
    conn, ctx = _seed_session(tmp_path, monkeypatch, sid, script)
    conn.close()

    state = _build_state(tmp_path, monkeypatch, sid)
    for sc in state["scenes"]:
        assert sc["templateOverride"] is None, (
            f"templateOverride should be null but got {sc['templateOverride']} at {sc['index']}")


def test_state_legacy_ungated_session_new_keys_present(tmp_path, monkeypatch):
    """Legacy/ungated sessions: new keys PRESENT with empty/null values (consistent shape).
    M6 reads one shape; absence would require null-guards on every access."""
    script = BeatsScript(title="Reefs", beats=[
        Beat(text="hook"),
        Beat(text="mid", keywords="coral reef"),
        Beat(text="outro"),
    ])
    sid = "t7-legacy"
    conn, ctx = _seed_session(tmp_path, monkeypatch, sid, script)
    conn.close()

    state = _build_state(tmp_path, monkeypatch, sid)
    # No gate rows → ungated session
    assert state["gates"] == {}
    # New keys must still be present on every scene
    for sc in state["scenes"]:
        assert "eligibleTemplates" in sc
        assert "templateOverride" in sc    # null (no rows)
        assert "backgroundPool" in sc       # {rows: [], poolError: None} for footage scene
        assert "backgroundProvenance" in sc # null for footage scenes
        assert "pickLogCount" in sc         # 0 for footage scene (no explicit log rows)


def test_state_pre_spec_partial_payload_unchanged(tmp_path, monkeypatch):
    """Pre-spec partial payload: scenes=[] (no spec yet); new keys must NOT appear
    (there are no scenes to add them to — partial path stays intact)."""
    from session import api as session_api, gatekeeper

    script = BeatsScript(title="Reefs", beats=[
        Beat(text="hook"),
        Beat(text="mid", keywords="coral reef"),
        Beat(text="out"),
    ])
    sid = "t7-prespec"
    sid_dir = tmp_path / "projects" / sid
    sid_dir.mkdir(parents=True, exist_ok=True)
    catalog = validate_stage.load_catalog(_TEMPLATES)
    _install_fakes(monkeypatch, script)
    ctx = EngineContext(
        topic="Reefs", fps=30, theme=Theme(), catalog=catalog,
        assets_dir=tmp_path / "a", cache_dir=tmp_path / "c",
        voiceover_path=tmp_path / "a" / projects_mod.voiceover_name(sid),
        spec_out=sid_dir / "spec.json",
        sources_out=sid_dir / "sources.json",
    )
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id=sid, topic="Reefs", now="t0")
    sess = session_api.Session(
        conn=conn,
        engine=engine.Engine(conn, ctx, session_id=sid),
        id=sid,
    )
    gatekeeper.start(sess)
    assert not (sid_dir / "spec.json").exists()
    conn.close()

    state = _build_state(tmp_path, monkeypatch, sid)
    assert state["scenes"] == [], "pre-spec partial payload must have empty scenes"
    assert "gates" in state
    assert state["gates"]["script"]["state"] == "awaiting_approval"


def test_state_existing_candidates_provenance_shape_unchanged(tmp_path, monkeypatch):
    """Legacy keys (candidates, provenance, needsFootage, durationInFrames, beatText)
    must have the same shape as before T7 — no regression on existing consumers."""
    script = BeatsScript(title="Reefs", beats=[
        Beat(text="hook"),
        Beat(text="mid", keywords="coral reef"),
        Beat(text="outro"),
    ])
    sid = "t7-compat"
    conn, ctx = _seed_session(tmp_path, monkeypatch, sid, script)
    conn.close()

    state = _build_state(tmp_path, monkeypatch, sid)
    # footage scene (index 1) — check legacy keys
    footage_scene = next(s for s in state["scenes"] if s["needsFootage"])
    cands = footage_scene["candidates"]
    assert len(cands) > 0
    assert {"rank", "thumbUrl", "durationFrames", "selected"} <= cands[0].keys()
    prov = footage_scene["provenance"]
    assert prov is not None and prov["source"] == "auto"
    # hero scene (index 0) — non-footage
    hook_scene = next(s for s in state["scenes"] if s["index"] == 0)
    assert hook_scene["candidates"] == []
    assert hook_scene["needsFootage"] is False
    assert hook_scene["durationInFrames"] is not None
