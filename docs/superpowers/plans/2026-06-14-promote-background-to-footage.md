# Unlock stat→scene (promote background clip to footage) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let a hero (stat/hook/outro) scene be switched to a footage `scene` template by promoting an already-picked Background clip into the scene's footage `Clip`; surface the gate visibly in the UI.

**Architecture:** Backend change in `engine._pick_template` (the existing no-footage rejection branch) to promote a `background_override` into a footage `Clip` before allowing the switch. Frontend change in `SceneControls.tsx` to enable the `scene` card when a background clip exists and to show a visible reason when it doesn't. TDD with the existing gate-ops pytest harness and the SceneControls jsdom harness.

**Tech Stack:** Python (pytest), Next.js/React (vitest + jsdom).

**Spec:** `docs/superpowers/specs/2026-06-14-promote-background-to-footage-design.md` (read it).

---

## File Structure

- `backend/session/engine.py` — `_pick_template` promote branch.
- `backend/tests/test_v3_m5_gate_ops.py` — promote + no-clip + replace tests (extend).
- `preview/components/scenes/SceneControls.tsx` — gate input + visible disabled reason.
- `preview/components/scenes/SceneControls.test.tsx` — enabled / disabled-with-reason tests (extend).

---

## Task 1: Backend — promote background clip → footage on hero→scene switch

**Files:**
- Modify: `backend/session/engine.py` (`_pick_template`, the `if not _has_clip:` branch ~L946-950)
- Test: `backend/tests/test_v3_m5_gate_ops.py` (extend)

Context: `pick_template` is invoked as `eng.edit("footage", {"op": "pick_template", "scene_index": N, "template": id})`. The test fixture `_make_session(tmp_path, monkeypatch)` returns `(eng, conn, ctx, catalog)`, loads the REAL template catalog, and advances script/voice/timing/footage. The fake script has beats `hook` (scene 0, hero), `mid` (scene 1, footage), `outro` (scene 2, hero). Heroes have no footage `Clip`. `store.get_background_overrides(conn, sid)` returns `{scene: {value, source, picked_rank, updated_at}}` with `value` a parsed dict shaped `{path, query, rank, pexels_id, pexels_url, duration_frames, kind}`. The footage bundle is `{"clips": [Clip], "candidates": {...}}`; `CODECS["footage"]` and `_load_output("footage")` are already used in this file (see `_edit_assemble` / the auto-fill hook).

- [ ] **Step 1: Write the failing promote test**

Add to `backend/tests/test_v3_m5_gate_ops.py`:

```python
# ── 12. pick_template hero→scene: promote background clip to footage ──────────

def test_pick_template_promotes_background_to_footage(tmp_path, monkeypatch):
    """A hero scene with a background clip but no footage clip can switch to the
    'scene' template: the background clip is promoted into the scene's footage."""
    eng, conn, ctx, catalog = _make_session(tmp_path, monkeypatch)
    eng.advance("assemble")

    # Seed a picked background clip on scene 0 (hook = hero, no footage clip).
    store.upsert_background_override(
        conn, "s1", 0,
        value={"path": "assets/footage_bg_reef_1.mp4", "query": "reef", "rank": 1,
               "pexels_id": 7, "pexels_url": "https://pexels.com/v/7",
               "duration_frames": 180, "kind": "video"},
        source="pinned", picked_rank=1, now="t1")

    # Switch the hero to a footage 'scene' template — must succeed via promotion.
    eng.edit("footage", {"op": "pick_template", "scene_index": 0, "template": "scene"})

    # A footage Clip for scene 0 now exists, carrying the background clip's data.
    foot = eng._load_output("footage")
    clip0 = next((c for c in foot["clips"] if c.index == 0), None)
    assert clip0 is not None, "background clip must be promoted to a footage clip at index 0"
    assert clip0.path == "assets/footage_bg_reef_1.mp4"
    assert clip0.duration_frames == 180
    assert clip0.pexels_id == 7

    # Template override written + assemble renders scene 0 as 'scene'.
    tmpl_overrides = store.get_template_overrides(conn, "s1")
    assert tmpl_overrides[0]["value"] == "scene"
    spec = eng._load_output("assemble")
    assert spec.scenes[0].template == "scene"
    conn.close()


def test_pick_template_hero_to_scene_without_clip_rejected(tmp_path, monkeypatch):
    """A hero with neither footage clip nor background clip is rejected with a
    clear 'pick a background clip first' message."""
    eng, conn, ctx, catalog = _make_session(tmp_path, monkeypatch)
    eng.advance("assemble")

    with pytest.raises(ValueError, match="pick a background clip first"):
        eng.edit("footage", {"op": "pick_template", "scene_index": 0, "template": "scene"})
    conn.close()


def test_pick_template_promote_replaces_existing_clip_at_index(tmp_path, monkeypatch):
    """Promoting when a clip already exists at the scene index replaces it (no dup)."""
    eng, conn, ctx, catalog = _make_session(tmp_path, monkeypatch)
    eng.advance("assemble")
    # Pre-seed a footage clip at index 0, then a background override, then switch.
    foot = eng._load_output("footage")
    from pipeline.contracts import Clip
    foot["clips"] = [c for c in foot["clips"] if c.index != 0] + [
        Clip(index=0, query="old", path="assets/old.mp4", duration_frames=60)]
    to_json, _ = engine.CODECS["footage"]
    store.upsert_stage(conn, "s1", "footage", status="done",
                       input_hash=store.get_stage(conn, "s1", "footage")["input_hash"],
                       output_json=json.dumps(to_json(foot), default=str), now="t1")
    store.upsert_background_override(
        conn, "s1", 0,
        value={"path": "assets/footage_bg_new_1.mp4", "query": "reef", "rank": 1,
               "pexels_id": 9, "pexels_url": "u", "duration_frames": 120, "kind": "video"},
        source="pinned", picked_rank=1, now="t2")

    eng.edit("footage", {"op": "pick_template", "scene_index": 0, "template": "scene"})

    foot2 = eng._load_output("footage")
    idx0 = [c for c in foot2["clips"] if c.index == 0]
    assert len(idx0) == 1, "exactly one clip at index 0 (replaced, not duplicated)"
    # NOTE: with a pre-existing footage clip the promotion branch may not fire
    # (the clip already satisfies the gate); this test pins 'no duplicate clips
    # at one index' regardless of which path runs.
    conn.close()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && source .venv/bin/activate && python -m pytest tests/test_v3_m5_gate_ops.py -k "promote or hero_to_scene_without_clip" -q`
Expected: the promote test FAILS (currently the switch raises "needs a footage pick"); the no-clip test FAILS (current message says "use the footage pool", not "pick a background clip first").

- [ ] **Step 3: Implement the promote branch in `_pick_template`**

In `backend/session/engine.py`, find the `if not _has_clip:` block (~L946-950) that currently does only:

```python
                    if not _has_clip:
                        raise ValueError(
                            f"assemble: template_override scene {scene}: switching to a footage "
                            f"layout needs a footage pick — use the footage pool"
                        )
```

Replace it with the promote-or-reject logic:

```python
                    if not _has_clip:
                        # Promote a picked background clip into this scene's footage,
                        # so a hero (stat/hook/outro) with a chosen background can become
                        # a footage 'scene'. Only reject if there's no clip to promote.
                        overrides = store.get_background_overrides(self.conn, self.sid)
                        bg = overrides.get(scene)
                        if bg and (bg.get("value") or {}).get("path"):
                            from pipeline.contracts import Clip
                            v = bg["value"]
                            promoted = Clip(
                                index=scene,
                                query=v.get("query") or "",
                                path=v["path"],
                                duration_frames=v.get("duration_frames"),
                                kind=v.get("kind", "video"),
                                rank=v.get("rank"),
                                pexels_id=v.get("pexels_id"),
                                pexels_url=v.get("pexels_url"),
                            )
                            bundle = _footage_out or {"clips": [], "candidates": {}}
                            bundle["clips"] = [
                                c for c in bundle.get("clips", []) if c.index != scene
                            ] + [promoted]
                            to_json, _ = CODECS["footage"]
                            store.upsert_stage(
                                self.conn, self.sid, "footage", status="done",
                                input_hash=store.get_stage(self.conn, self.sid, "footage")["input_hash"],
                                output_json=json.dumps(to_json(bundle), default=str), now=_now())
                        else:
                            raise ValueError(
                                f"assemble: template_override scene {scene}: pick a background "
                                f"clip first, then switch to a scene template"
                            )
```

(`_footage_out` is already loaded just above this branch as `self._load_output("footage")`. `CODECS`, `json`, `_now`, `store` are already imported/in scope in this module — confirm and reuse; do not add duplicate imports.)

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `cd backend && source .venv/bin/activate && python -m pytest tests/test_v3_m5_gate_ops.py -k "promote or hero_to_scene_without_clip" -q`
Expected: PASS (3 tests, incl. the replace test).

- [ ] **Step 5: Run the full gate-ops + assemble suites (no regressions)**

Run: `cd backend && source .venv/bin/activate && python -m pytest tests/test_v3_m5_gate_ops.py tests/test_studio_assemble_gate.py tests/test_v3_m5_assemble_overrides.py tests/test_spec_patch.py -q`
Expected: all pass (existing pick_template/footage tests unaffected).

- [ ] **Step 6: Commit**

```bash
cd /home/zain-ali/Documents/AIVideoGenerationTool
git add backend/session/engine.py backend/tests/test_v3_m5_gate_ops.py
git commit -m "feat(scenes): promote a hero's background clip to footage on stat->scene switch

A stat/hook/outro scene with a picked background clip can now switch to the
footage 'scene' template: _pick_template promotes the background_override into a
footage Clip at that index instead of rejecting. No background clip -> clearer
'pick a background clip first' error."
```

---

## Task 2: Frontend — enable the `scene` card when a background clip exists; show a visible reason when not

**Files:**
- Modify: `preview/components/scenes/SceneControls.tsx`
- Test: `preview/components/scenes/SceneControls.test.tsx` (extend)

Context: `SceneControls` computes `const heroClipless = !scene.needsFootage && scene.candidates.length === 0;` and passes it to `TemplateCardRail`, which computes `gated = t === 'scene' && heroClipless && !active` and renders the gated card `disabled` with an `sr-only` reason (no visible text). `SceneState` has `backgroundProvenance: BackgroundProvenance | null` (non-null once a background clip is picked). `TemplateCardRail`'s test props include `heroClipless`.

- [ ] **Step 1: Write/extend the failing tests**

In `preview/components/scenes/SceneControls.test.tsx`, add to the `TemplateCardRail` describe block:

```tsx
  it('enables the scene card on a hero that has a background clip', () => {
    // heroClipless=false means a background clip exists -> scene is selectable
    act(() => root.render(createElement(TemplateCardRail, {
      ...baseProps, current: 'stat', templates: ['scene', 'stat'], heroClipless: false,
    })));
    const sceneCard = Array.from(container.querySelectorAll('[role="radio"]'))
      .find((el) => el.textContent?.includes('scene')) as HTMLButtonElement;
    expect(sceneCard.disabled).toBe(false);
  });

  it('shows a VISIBLE reason on the disabled scene card (not sr-only only)', () => {
    act(() => root.render(createElement(TemplateCardRail, {
      ...baseProps, current: 'stat', templates: ['scene', 'stat'], heroClipless: true,
    })));
    const sceneCard = Array.from(container.querySelectorAll('[role="radio"]'))
      .find((el) => el.textContent?.includes('scene')) as HTMLButtonElement;
    expect(sceneCard.disabled).toBe(true);
    // a visible (non sr-only) element carries the reason text
    const visibleReason = Array.from(sceneCard.querySelectorAll('*')).find(
      (el) => /pick a (background )?clip/i.test(el.textContent || '')
        && !el.className.includes('sr-only'),
    );
    expect(visibleReason).toBeTruthy();
  });
```

(The existing `disables the scene card on a clipless hero` test stays — it uses `heroClipless: true` and asserts `disabled` + `aria-describedby`.)

- [ ] **Step 2: Run to verify failure**

Run: `cd preview && npx vitest run components/scenes/SceneControls.test.tsx`
Expected: the new "enables…" test may already pass (heroClipless=false already enables), but the "VISIBLE reason" test FAILS (the reason is currently `sr-only` only).

- [ ] **Step 3: Update the `heroClipless` gate input**

In `SceneControls.tsx`, change:

```tsx
  const heroClipless = !scene.needsFootage && scene.candidates.length === 0;
```

to also require the absence of a background clip:

```tsx
  // A hero is "clipless" (can't become a footage scene) only when it has neither
  // footage candidates NOR a picked background clip. A background clip is promoted
  // to footage on the stat->scene switch (see engine._pick_template).
  const heroClipless =
    !scene.needsFootage && scene.candidates.length === 0 && scene.backgroundProvenance == null;
```

- [ ] **Step 4: Add a visible reason to the gated card**

In `TemplateCardRail`, the gated card currently renders only an `sr-only` reason span. Add a small VISIBLE caption on the card when `gated` (keep the `sr-only` long reason for the full sentence). Inside the card `<button>`, replace the gated `sr-only` block:

```tsx
            {gated && (
              <span id={descId} className="sr-only">
                pick a clip first — a scene template needs footage
              </span>
            )}
```

with a visible chip plus the sr-only full sentence:

```tsx
            {gated && (
              <>
                <span className="absolute inset-x-0 top-0 bg-warn/85 px-1 py-0.5 text-center font-mono text-[8px] font-bold text-[#1a1308]">
                  needs a clip
                </span>
                <span id={descId} className="sr-only">
                  pick a background clip first, then switch to a scene template
                </span>
              </>
            )}
```

(`bg-warn` is already used elsewhere in this file for the pending badge; reuse it. The visible chip sits at the top so it doesn't collide with the bottom name/auto label.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd preview && npx vitest run components/scenes/SceneControls.test.tsx`
Expected: all green (TemplateCardRail tests incl. the two new ones + pool rails).

- [ ] **Step 6: Full preview suite + typecheck**

Run: `cd preview && npx vitest run && npx tsc --noEmit`
Expected: full suite green; tsc exit 0.

- [ ] **Step 7: Commit**

```bash
cd /home/zain-ali/Documents/AIVideoGenerationTool
git add preview/components/scenes/SceneControls.tsx preview/components/scenes/SceneControls.test.tsx
git commit -m "feat(scenes): enable scene template on heroes with a background clip + visible gate reason

The scene card un-gates for a hero once a background clip exists (it's promoted to
footage on switch); when still gated it shows a visible 'needs a clip' chip instead
of an invisible sr-only-only reason."
```

---

## Task 3: Operator eyes-on (merge gate, manual)

**No files. Verification only.**

- [ ] **Step 1: Full backend + preview suites green**

Run: `cd backend && source .venv/bin/activate && python -m pytest -q` (expect all pass) and `cd preview && npx vitest run && npx tsc --noEmit` (expect green).

- [ ] **Step 2: Drive scene 04 on real pixels**

Hard-reload `http://localhost:3000/video/v3-54fc4f223e5d452dbad0d512eb454b0b/scenes`, expand scene 04. With no background clip, confirm the `scene` card shows the visible "needs a clip" reason and is not clickable. Then pick a Background clip → the `scene` card enables → click it → the left preview re-renders scene 04 as a footage scene of that clip. Capture to `/mnt/user-data/uploads`.

- [ ] **Step 3: Hand the capture to the operator for the ruling.** Merge only after the operator confirms on real pixels.

---

## Self-Review

**Spec coverage:**
- Goal 1 (switch succeeds, bg→footage) → Task 1 (promote branch + promote test). ✓
- Goal 2 (card enabled when bg clip; visible reason when not) → Task 2. ✓
- Goal 3 (reject when no clip, clear message) → Task 1 (no-clip test + new message). ✓

**Placeholder scan:** none — all steps carry concrete code/commands.

**Type consistency:** backend uses the `Clip` contract fields exactly (`index/query/path/duration_frames/kind/rank/pexels_id/pexels_url`); `CODECS["footage"]`, `_now`, `store`, `json` are existing module symbols (Task 1 Step 3 says confirm + reuse, no new imports). Frontend: `heroClipless` (boolean) feeds `TemplateCardRail`'s existing `heroClipless` prop; `scene.backgroundProvenance` is `BackgroundProvenance | null` per `studio.ts`. Test prop names match `baseProps`.
