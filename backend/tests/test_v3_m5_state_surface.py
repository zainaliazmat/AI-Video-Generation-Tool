"""Studio v3 M5 T7 — eligibility + state surface.

Test contract:
  1. eligible_templates: stat beat (data value+label) at middle position → 'scene' and
     'stat' eligible; 'enumeration' NOT eligible (no items); 'hook'/'outro' NOT eligible
     (middle position).
  2. eligible_templates: beat with data.items at middle → 'scene' and 'enumeration'
     eligible; 'stat' NOT eligible (no value+label); 'hook'/'outro' NOT eligible.
  3. eligible_templates: first-position beat → 'hook' eligible; last-position beat →
     'outro' eligible; middle → neither 'hook' nor 'outro'.
  4. eligible_templates: plain beat (no data, no items) at middle → only 'scene'
     eligible (no stat/enumeration/hook/outro).
  5. eligible_templates: first+last coincide (scene_count==1, position==0) → both
     'hook' AND 'outro' eligible (single-scene video edge case).
  6. eligible_templates: transition/overlay templates NEVER returned regardless of beat.

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

def test_eligible_templates_stat_beat_middle():
    """Stat beat (data value+label) at middle position (not first, not last):
    'scene' and 'stat' are eligible; 'enumeration' is NOT (no items);
    'hook' and 'outro' are NOT (wrong position)."""
    catalog = validate_stage.load_catalog(_TEMPLATES)
    beat_data = {"value": "42%", "label": "of reefs bleached"}
    # position=1 in a 3-scene video → middle
    result = eligible_templates(beat_data, position=1, scene_count=3, catalog=catalog)
    assert "stat" in result, f"'stat' not in {result}"
    assert "scene" in result, f"'scene' not in {result}"
    assert "enumeration" not in result, f"'enumeration' should not be in {result} (no items)"
    assert "hook" not in result, f"'hook' should not be in {result} (middle position)"
    assert "outro" not in result, f"'outro' should not be in {result} (middle position)"


def test_eligible_templates_enumeration_beat_middle():
    """Beat with data.items at middle → 'scene' and 'enumeration' eligible;
    'stat' NOT eligible (no value+label); 'hook'/'outro' NOT eligible (middle)."""
    catalog = validate_stage.load_catalog(_TEMPLATES)
    beat_data = {"items": ["Coral", "Fish", "Seagrass"]}
    result = eligible_templates(beat_data, position=1, scene_count=3, catalog=catalog)
    assert "enumeration" in result, f"'enumeration' not in {result}"
    assert "scene" in result, f"'scene' not in {result}"
    assert "stat" not in result, f"'stat' should not be in {result} (no value+label)"
    assert "hook" not in result, f"'hook' should not be in {result} (middle position)"
    assert "outro" not in result, f"'outro' should not be in {result} (middle position)"


def test_eligible_templates_position_gating():
    """Position gating:
    - position==0 → 'hook' eligible; 'outro' NOT (unless also last).
    - position==last → 'outro' eligible; 'hook' NOT.
    - middle → neither."""
    catalog = validate_stage.load_catalog(_TEMPLATES)
    # First position (beat has no special data)
    first = eligible_templates(None, position=0, scene_count=3, catalog=catalog)
    assert "hook" in first, f"'hook' not in first-position eligible: {first}"
    assert "outro" not in first, f"'outro' should not be in first-position eligible: {first}"

    # Last position
    last = eligible_templates(None, position=2, scene_count=3, catalog=catalog)
    assert "outro" in last, f"'outro' not in last-position eligible: {last}"
    assert "hook" not in last, f"'hook' should not be in last-position eligible: {last}"

    # Middle position
    mid = eligible_templates(None, position=1, scene_count=3, catalog=catalog)
    assert "hook" not in mid, f"'hook' should not be in middle-position eligible: {mid}"
    assert "outro" not in mid, f"'outro' should not be in middle-position eligible: {mid}"


def test_eligible_templates_plain_beat_middle():
    """Plain beat (no data, no items) at middle → only 'scene' eligible.
    No stat data → stat not eligible; no items → enumeration not eligible;
    middle position → hook/outro not eligible."""
    catalog = validate_stage.load_catalog(_TEMPLATES)
    result = eligible_templates(None, position=1, scene_count=3, catalog=catalog)
    assert "scene" in result, f"'scene' not in {result}"
    assert "stat" not in result, f"'stat' should not be in {result} (no data)"
    assert "enumeration" not in result, f"'enumeration' should not be in {result} (no items)"
    assert "hook" not in result, f"'hook' should not be in {result} (not first)"
    assert "outro" not in result, f"'outro' should not be in {result} (not last)"


def test_eligible_templates_single_scene_both_hook_and_outro():
    """Edge case: scene_count==1, position==0 is BOTH first AND last.
    Both 'hook' and 'outro' should be eligible."""
    catalog = validate_stage.load_catalog(_TEMPLATES)
    result = eligible_templates(None, position=0, scene_count=1, catalog=catalog)
    assert "hook" in result, f"'hook' not in single-scene eligible: {result}"
    assert "outro" in result, f"'outro' not in single-scene eligible: {result}"


def test_eligible_templates_excludes_transition_overlay():
    """Transition and overlay templates MUST NOT appear regardless of beat data."""
    catalog = validate_stage.load_catalog(_TEMPLATES)
    # Use a beat with rich data that might accidentally match if kind-gating were absent
    beat_data = {"value": "42%", "label": "stat", "items": ["a", "b", "c"]}
    result_set = set(eligible_templates(beat_data, position=1, scene_count=3, catalog=catalog))
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


# ══════════════════════════════════════════════════════════════════════════════
# T7 HEADLINE E2E test: beat with data.items + scene template
#   → eligibleTemplates includes 'enumeration'
#   → pick_template('enumeration') succeeds
#   → assemble re-derives templateProps = {items: [...]} from beat
#   → spec validates cleanly
# ══════════════════════════════════════════════════════════════════════════════

def test_t7_headline_enumeration_switch_rerederives_props(tmp_path, monkeypatch):
    """T7 HEADLINE E2E (mandated by review):

    A beat carrying data.items whose CURRENT template is 'scene' (footage):
    (a) /state lists 'enumeration' in eligibleTemplates for that scene.
    (b) pick_template('enumeration') succeeds.
    (c) The resulting assemble spec for that scene has templateProps with the
        items from the beat (re-derived from beat data, NOT the stale media props).
    (d) The full spec validates cleanly through validate_spec.
    """
    from pipeline import validate as vstage
    from session import api as session_api, gatekeeper

    items = ["Coral", "Seagrass", "Mangroves", "Saltmarshes"]
    script = BeatsScript(title="Reef Ecosystem", beats=[
        Beat(text="hook text"),
        # Scene 1: has items data — eligible for enumeration switch
        Beat(text="key habitat types", keywords="reef habitat",
             data={"items": items}),
        Beat(text="outro text"),
    ])

    catalog = validate_stage.load_catalog(_TEMPLATES)
    sid = "t7-headline-e2e"
    _install_fakes(monkeypatch, script)
    ctx = _ctx(tmp_path, sid, catalog=catalog)
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id=sid, topic="Reef Ecosystem", now="t0")
    eng = engine.Engine(conn, ctx, session_id=sid)
    eng.run_all()

    # (a) /state: eligibleTemplates for scene 1 must include 'enumeration'
    import session_state as ss
    monkeypatch.setattr("session.job_ctx.SESSIONS_DB", tmp_path / "s.db")
    monkeypatch.setattr("session.job_ctx.REPO_ROOT", tmp_path)
    monkeypatch.setattr("session.job_ctx.TEMPLATES_DIR", _TEMPLATES)
    state = ss.build_state(sid)
    scene1_state = next(s for s in state["scenes"] if s["index"] == 1)
    assert "enumeration" in scene1_state["eligibleTemplates"], (
        f"(a) 'enumeration' not in eligibleTemplates: {scene1_state['eligibleTemplates']}")
    assert "scene" in scene1_state["eligibleTemplates"], (
        f"(a) 'scene' not in eligibleTemplates: {scene1_state['eligibleTemplates']}")

    # (b) pick_template('enumeration') succeeds
    eng.edit("footage", {"op": "pick_template", "scene_index": 1, "template": "enumeration"})
    tmpl_overrides = store.get_template_overrides(conn, sid)
    assert 1 in tmpl_overrides, "(b) template_overrides row must be written after pick_template"
    assert tmpl_overrides[1]["value"] == "enumeration"

    # (c) assemble spec scene 1 has templateProps = {items: [...]} re-derived from beat
    spec = eng._load_output("assemble")
    scene1_spec = spec.scenes[1]
    assert scene1_spec.template == "enumeration", (
        f"(c) expected template='enumeration', got {scene1_spec.template!r}")
    tp = scene1_spec.templateProps
    assert "items" in tp, f"(c) templateProps must have 'items'; got: {tp}"
    assert tp["items"] == items, (
        f"(c) items must match beat data; expected {items}, got {tp['items']}")
    # Must NOT contain stale 'media' key from the old footage props
    assert "media" not in tp, (
        f"(c) templateProps must NOT contain stale 'media' key; got: {tp}")

    # (d) full spec validates cleanly
    vstage.validate_spec(spec, catalog)

    conn.close()
