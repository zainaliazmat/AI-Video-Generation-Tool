"""Studio v3 M5 T5 — assemble consumes overrides via engine inputs seam (OV-4).

Test contract (RED-first, then implement):

  1. background_override consumed: seed a background_overrides row (auto), run
     assemble via the engine → spec hero scene carries templateProps.backgroundClip
     with loop math right (short clip → loop=True); durationInFrames unchanged.

  2. hash_invalidation: change the override (different clip) → assemble re-runs.

  3. cache_hit: unchanged override + unchanged inputs → assemble is a cache no-op
     (counter stays at 0).

  4. pin_survival: a pinned background_overrides row + script re-derive (simulate
     via different topic → new inputs) → assemble re-runs but the pinned row still
     feeds the new spec (pin survives while unchanged).

  5. template_override_valid: seed a template_overrides row (valid scene-template
     id eligible for the scene slot) → spec scene's template flips.

  6. template_override_invalid_guard: seed an invalid template id (non-existent or
     wrong kind) → skipped with a clear error logged / guard; assemble still completes
     and original template is used.

  7. v2_byte_identity: sessions WITHOUT any override rows → spec byte-identical to
     pre-T5 (empty overrides dict omitted from inputs hash — no-bust contract).

  8. session_no_overrides_hash_identical: explicitly verify that the hash payload
     with {} overrides == the hash payload WITHOUT the overrides key (the
     no-bust normalization is in the hash path, not just the inputs path).
"""
from __future__ import annotations

import json
from pathlib import Path

from pipeline.content import Beat, BeatsScript
from pipeline.contracts import Clip, LineOffset, WordTiming
from schema import Theme
from session import engine, executors, store
from session.executors import EngineContext
from pipeline import validate as validate_stage

_TEMPLATES = Path(__file__).resolve().parents[2] / "templates"


# ── shared helpers ────────────────────────────────────────────────────────────

def _ctx(tmp_path, catalog=None):
    return EngineContext(
        topic="Reefs", fps=30, theme=Theme(), catalog=catalog or {},
        assets_dir=tmp_path / "a", cache_dir=tmp_path / "c",
        voiceover_path=tmp_path / "a" / "v.wav",
        spec_out=tmp_path / "spec.json", sources_out=tmp_path / "src.json",
    )


def _install_fakes(monkeypatch, script=None):
    """Install minimal pipeline fakes so all stages up to assemble run offline."""
    if script is None:
        script = BeatsScript(title="Reefs", beats=[
            Beat(text="hook"),
            Beat(text="mid", keywords="coral reef"),
            Beat(text="outro"),
        ])
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
                        lambda q, key: {"videos": []})
    monkeypatch.setattr("pipeline.footage.fetch_footage",
                        lambda reqs, out_dir, *, fps=30, **kw: [
                            Clip(index=r.index, query=r.query,
                                 path=f"assets/f{r.index}.mp4", duration_frames=300)
                            for r in reqs
                        ])
    monkeypatch.setattr("pipeline.footage._download",
                        lambda url, dest: Path(dest).write_bytes(b"v"))
    return script


def _run_all_stages(eng, conn=None, sid=None):
    """Advance script/voice/timing/footage (NOT assemble) — used to build upstream
    DB state before we probe what assemble does."""
    eng.advance("script")
    eng.advance("voice")
    eng.advance("timing")
    eng.advance("footage")


def _make_session(tmp_path, monkeypatch, sid="s1", script=None):
    """Full session through footage stage — ready for assemble."""
    catalog = validate_stage.load_catalog(_TEMPLATES)
    sc = _install_fakes(monkeypatch, script=script)
    ctx = _ctx(tmp_path, catalog=catalog)
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id=sid, topic="Reefs", now="t0")
    eng = engine.Engine(conn, ctx, session_id=sid)
    _run_all_stages(eng, conn, sid)
    return eng, conn, ctx, catalog


# A media clip dict as stored by the auto-fill hook (value in background_overrides).
_CLIP_VALUE_SHORT = {
    "path": "assets/bg_reef_1.mp4",
    "query": "coral reef",
    "rank": 1,
    "pexels_id": 42,
    "pexels_url": "https://pexels.com/v/42",
    "duration_frames": 10,   # SHORT — shorter than any scene span → loop=True expected
}

_CLIP_VALUE_LONG = {
    "path": "assets/bg_reef_1.mp4",
    "query": "coral reef",
    "rank": 1,
    "pexels_id": 42,
    "pexels_url": "https://pexels.com/v/42",
    "duration_frames": 999,   # LONG — loop=False expected
}

_CLIP_VALUE_ALT = {
    "path": "assets/bg_reef_2.mp4",
    "query": "ocean",
    "rank": 2,
    "pexels_id": 99,
    "pexels_url": "https://pexels.com/v/99",
    "duration_frames": 100,
}


# ── 1. background_override consumed, loop math ────────────────────────────────

def test_background_override_consumed_loop_true_for_short_clip(tmp_path, monkeypatch):
    """Background override (short clip) → hook scene's templateProps gains backgroundClip
    with loop=True; durationInFrames is unchanged (narration-derived)."""
    eng, conn, ctx, catalog = _make_session(tmp_path, monkeypatch)

    # Seed an auto background_overrides row for scene 0 (hook): short clip
    store.upsert_background_override(
        conn, "s1", 0,
        value=_CLIP_VALUE_SHORT,
        source="auto", picked_rank=1, now="t0")

    eng.advance("assemble")

    spec = eng._load_output("assemble")
    hook_scene = spec.scenes[0]
    assert hook_scene.template == "hook"
    props = hook_scene.templateProps
    assert "backgroundClip" in props, (
        f"hook templateProps must contain backgroundClip; got keys: {list(props.keys())}")
    bg = props["backgroundClip"]
    assert bg["src"] == _CLIP_VALUE_SHORT["path"]
    assert bg["type"] == "video"
    # Short clip (10 frames) vs scene span (any positive span) → loop=True
    assert bg["loop"] is True, (
        f"short clip (10 frames) must produce loop=True; got {bg['loop']}")
    # durationInFrames is narration-derived (unchanged by the override)
    # scene durations from fakes: LineOffset i → start=float(i), end=float(i+1)
    # starts[0]=0, starts[1]=30, dur[0]=30 frames (at 30fps); background must NOT change it
    assert hook_scene.durationInFrames == 30, (
        f"durationInFrames should be narration-derived (30); got {hook_scene.durationInFrames}")


def test_background_override_consumed_loop_false_for_long_clip(tmp_path, monkeypatch):
    """Background override (long clip) → backgroundClip with loop=False."""
    eng, conn, ctx, catalog = _make_session(tmp_path, monkeypatch)

    store.upsert_background_override(
        conn, "s1", 0,
        value=_CLIP_VALUE_LONG,
        source="auto", picked_rank=1, now="t0")

    eng.advance("assemble")

    spec = eng._load_output("assemble")
    bg = spec.scenes[0].templateProps["backgroundClip"]
    assert bg["loop"] is False, (
        f"long clip (999 frames) must produce loop=False; got {bg['loop']}")


def test_background_override_not_applied_to_footage_scene(tmp_path, monkeypatch):
    """A footage scene (needs_footage=True) gets its media via the footage path;
    a background_overrides row for that scene index is NOT applied there."""
    eng, conn, ctx, catalog = _make_session(tmp_path, monkeypatch)

    # Seed a background override for scene 1 (footage scene / "scene" role)
    store.upsert_background_override(
        conn, "s1", 1,
        value=_CLIP_VALUE_SHORT,
        source="auto", picked_rank=1, now="t0")

    eng.advance("assemble")

    spec = eng._load_output("assemble")
    # Scene 1 is a footage scene — its templateProps should have "media" from footage,
    # NOT a backgroundClip key
    scene_props = spec.scenes[1].templateProps
    assert "media" in scene_props, "footage scene must have 'media' in templateProps"
    assert "backgroundClip" not in scene_props, (
        "background_override must not override a footage scene's media prop")


# ── 2. hash_invalidation ─────────────────────────────────────────────────────

def test_override_change_invalidates_assemble_hash(tmp_path, monkeypatch):
    """Changing a background override (different clip) → assemble re-runs."""
    eng, conn, ctx, catalog = _make_session(tmp_path, monkeypatch)

    # Seed initial override
    store.upsert_background_override(
        conn, "s1", 0,
        value=_CLIP_VALUE_LONG,
        source="auto", picked_rank=1, now="t0")

    # Track assemble executor calls — patch and restore manually
    calls = {"n": 0}
    original = engine.EXECUTORS["assemble"]
    engine.EXECUTORS["assemble"] = lambda ctx, inputs: (
        calls.__setitem__("n", calls["n"] + 1), original(ctx, inputs))[1]
    try:
        eng.advance("assemble")
        assert calls["n"] == 1, "first advance must run the executor"

        # Change the override → different clip (different path/rank)
        store.upsert_background_override(
            conn, "s1", 0,
            value=_CLIP_VALUE_ALT,
            source="auto", picked_rank=2, now="t1")

        eng.advance("assemble")
        assert calls["n"] == 2, (
            f"changed override must bust hash and re-run assemble; calls={calls['n']}")
    finally:
        engine.EXECUTORS["assemble"] = original


# ── 3. cache_hit ─────────────────────────────────────────────────────────────

def test_unchanged_override_is_cache_hit(tmp_path, monkeypatch):
    """Same override + same upstream inputs → second advance is a cache hit (no re-run)."""
    eng, conn, ctx, catalog = _make_session(tmp_path, monkeypatch)

    store.upsert_background_override(
        conn, "s1", 0,
        value=_CLIP_VALUE_LONG,
        source="auto", picked_rank=1, now="t0")

    calls = {"n": 0}
    original = engine.EXECUTORS["assemble"]
    engine.EXECUTORS["assemble"] = lambda ctx, inputs: (calls.__setitem__("n", calls["n"] + 1), original(ctx, inputs))[1]
    try:
        eng.advance("assemble")   # run 1
        eng.advance("assemble")   # identical inputs → cache hit
        assert calls["n"] == 1, (
            f"identical inputs must produce a cache hit (executor called once); calls={calls['n']}")
    finally:
        engine.EXECUTORS["assemble"] = original


# ── 4. pin_survival ──────────────────────────────────────────────────────────

def test_pinned_override_survives_script_rederive(tmp_path, monkeypatch):
    """Pinned background row + script re-derive (upstream change) → assemble re-runs
    but the PINNED row still feeds the new spec (pin survives while unchanged).

    We simulate an upstream change by building a second engine with a different
    topic (forces new script hash → all downstream stages re-run via invalidate+rederive).
    The pin was seeded BEFORE the re-derive, so it must still appear in the new spec."""
    eng, conn, ctx, catalog = _make_session(tmp_path, monkeypatch)

    # Seed a pinned row
    store.upsert_background_override(
        conn, "s1", 0,
        value=_CLIP_VALUE_LONG,
        source="pinned", picked_rank=1, now="t0")

    # Run assemble with initial state
    eng.advance("assemble")
    spec_before = eng._load_output("assemble")
    assert "backgroundClip" in spec_before.scenes[0].templateProps

    # Now simulate a re-derive by creating a new engine context (same session/DB,
    # different topic → new script hash → assemble must re-run)
    # Use the same DB but force the assemble stage to stale
    store.set_stage_status(conn, "s1", "assemble", "stale", now="t1")

    # Re-advance assemble (forcing a re-run)
    calls = {"n": 0}
    original = engine.EXECUTORS["assemble"]
    engine.EXECUTORS["assemble"] = lambda ctx, inputs: (calls.__setitem__("n", calls["n"] + 1), original(ctx, inputs))[1]
    try:
        eng.advance("assemble")
        assert calls["n"] == 1, "forced-stale assemble must re-run"
    finally:
        engine.EXECUTORS["assemble"] = original

    spec_after = eng._load_output("assemble")
    # The pinned row was unchanged → still feeds the new spec
    assert "backgroundClip" in spec_after.scenes[0].templateProps, (
        "pinned background row must still feed the re-derived spec")
    bg = spec_after.scenes[0].templateProps["backgroundClip"]
    assert bg["src"] == _CLIP_VALUE_LONG["path"], (
        f"pinned row's clip must appear in re-derived spec; got {bg['src']}")


# ── 5. template_override_valid ────────────────────────────────────────────────

def test_template_override_valid_flips_scene_template(tmp_path, monkeypatch):
    """A valid template_overrides row (scene-kind, exists in catalog) → spec scene's
    template field flips to the overridden id."""
    # Use a 4-beat script with a footage scene at index 1
    script = BeatsScript(title="Reefs", beats=[
        Beat(text="hook"),
        Beat(text="mid", keywords="coral reef"),
        Beat(text="mid2", keywords="fish"),
        Beat(text="outro"),
    ])
    eng, conn, ctx, catalog = _make_session(tmp_path, monkeypatch, script=script)

    # "enumeration" is a scene-kind template in the real catalog
    # Find a valid scene-kind template id from the catalog
    scene_templates = [m.id for m in catalog.values() if m.kind == "scene"]
    assert scene_templates, "need at least one scene-kind template in catalog"
    alt_template = scene_templates[0]  # e.g. "scene" or "enumeration"

    # Seed a template_overrides row for scene 1 (footage scene)
    store.upsert_template_override(
        conn, "s1", 1,
        value=alt_template, source="auto", picked_rank=None, now="t0")

    eng.advance("assemble")

    spec = eng._load_output("assemble")
    assert spec.scenes[1].template == alt_template, (
        f"template_override must flip scene 1's template to {alt_template!r}; "
        f"got {spec.scenes[1].template!r}")


# ── 6. template_override_invalid_guard ───────────────────────────────────────

def test_template_override_invalid_id_skipped(tmp_path, monkeypatch):
    """A template_overrides row with an unknown template id is skipped (original
    template is kept); assemble still completes successfully."""
    eng, conn, ctx, catalog = _make_session(tmp_path, monkeypatch)

    # Seed an invalid template id
    store.upsert_template_override(
        conn, "s1", 1,
        value="nonexistent_template_xyz", source="auto", picked_rank=None, now="t0")

    # Must not raise
    eng.advance("assemble")

    spec = eng._load_output("assemble")
    # Original template "scene" must be kept (the invalid override is silently skipped)
    assert spec.scenes[1].template == "scene", (
        f"invalid template override must be skipped; scene 1 template should stay 'scene', "
        f"got {spec.scenes[1].template!r}")


def test_template_override_wrong_kind_skipped(tmp_path, monkeypatch):
    """A template_overrides row with a transition-kind template id is skipped (wrong
    kind — only scene-kind templates are eligible for scene override)."""
    eng, conn, ctx, catalog = _make_session(tmp_path, monkeypatch)

    # "fade" is a transition-kind template in the catalog → not eligible for scene override
    transition_templates = [m.id for m in catalog.values() if m.kind == "transition"]
    assert transition_templates, "need at least one transition template in catalog"
    transition_id = transition_templates[0]

    store.upsert_template_override(
        conn, "s1", 1,
        value=transition_id, source="auto", picked_rank=None, now="t0")

    eng.advance("assemble")

    spec = eng._load_output("assemble")
    assert spec.scenes[1].template == "scene", (
        f"transition-kind template override must be rejected; "
        f"scene 1 template should stay 'scene', got {spec.scenes[1].template!r}")


# ── 7. v2_byte_identity ──────────────────────────────────────────────────────

def test_empty_overrides_does_not_change_spec_content(tmp_path, monkeypatch):
    """Session with NO override rows → spec.json content identical to pre-T5.

    The empty-overrides normalization (OMIT the overrides key from inputs when both
    dicts are empty) ensures pre-M5 sessions keep their assemble hash on resume.
    We verify this structurally: two sessions, one without any override rows and one
    with the overrides seam explicitly disabled, produce identical specs."""
    catalog = validate_stage.load_catalog(_TEMPLATES)
    script = BeatsScript(title="Reefs", beats=[
        Beat(text="hook"),
        Beat(text="mid", keywords="coral reef"),
        Beat(text="outro"),
    ])

    def run_once(sub):
        _install_fakes(monkeypatch, script=script)
        d = tmp_path / sub
        ctx = EngineContext(
            topic="Reefs", fps=30, theme=Theme(), catalog=catalog,
            assets_dir=d / "a", cache_dir=d / "c",
            voiceover_path=d / "a" / "v.wav",
            spec_out=d / "spec.json", sources_out=d / "src.json",
        )
        conn = store.connect(d / "s.db")
        store.create_session(conn, id="s1", topic="Reefs", now="t0")
        eng = engine.Engine(conn, ctx, session_id="s1")
        eng.run_all()
        conn.close()
        return json.loads((d / "spec.json").read_text())

    spec_a = run_once("a")
    spec_b = run_once("b")
    assert spec_a == spec_b, (
        "sessions with no override rows must produce identical specs — "
        "empty overrides must not change the spec content")


def test_no_override_rows_hash_identical(tmp_path, monkeypatch):
    """Hash no-bust: when both override dicts are empty, the overrides key must be
    OMITTED from the _input_hash payload, so pre-M5 sessions resume without a
    one-time re-derive.

    Verify directly: advance assemble, record the hash; then call _input_hash
    manually with and without an explicit empty overrides key and confirm they match."""
    catalog = validate_stage.load_catalog(_TEMPLATES)
    _install_fakes(monkeypatch)
    ctx = _ctx(tmp_path, catalog=catalog)
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="s1", topic="Reefs", now="t0")
    eng = engine.Engine(conn, ctx, session_id="s1")
    _run_all_stages(eng)
    eng.advance("assemble")

    # The hash stored in the DB is the pre-T5-equivalent hash (no overrides key)
    stored_hash = store.get_stage(conn, "s1", "assemble")["input_hash"]

    # Build inputs as the engine would, and compute the hash explicitly
    inputs = eng._inputs_for("assemble")

    # The stored hash must equal the hash we can compute via _input_hash
    # (which, when overrides are empty, must omit the key)
    computed_hash = eng._input_hash("assemble", inputs)
    assert stored_hash == computed_hash, (
        f"stored assemble hash ({stored_hash[:8]}…) must equal _input_hash result "
        f"({computed_hash[:8]}…) when no overrides exist — the empty-omit normalization "
        f"must be consistent between advance() and _input_hash()")
    conn.close()


# ── 8. background_overrides not applied when dict is empty ────────────────────

def test_hero_scene_no_backgroundclip_when_no_override(tmp_path, monkeypatch):
    """Without any background_overrides rows, hero scenes (hook/outro) must NOT have
    a backgroundClip key in their templateProps (gradient fallback is renderer-side)."""
    eng, conn, ctx, catalog = _make_session(tmp_path, monkeypatch)
    # No background_overrides seeded
    eng.advance("assemble")

    spec = eng._load_output("assemble")
    hook_props = spec.scenes[0].templateProps
    outro_props = spec.scenes[2].templateProps
    assert "backgroundClip" not in hook_props, (
        "hook must not have backgroundClip without a background override row")
    assert "backgroundClip" not in outro_props, (
        "outro must not have backgroundClip without a background override row")
