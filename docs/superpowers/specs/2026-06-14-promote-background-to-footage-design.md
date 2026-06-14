# Unlock stat→scene: promote a background clip to footage

**Date:** 2026-06-14
**Branch:** `studio-v3-staged-flow`
**Surfaces:** `backend/session/engine.py` (`_pick_template`), `preview/components/scenes/SceneControls.tsx` (template card gate)
**Type:** Backend behavior change + small frontend gate change.

## Problem

A stat (hero) scene cannot be switched to a footage `scene` template from the UI,
and there is no path to make it possible. The gate in `engine._pick_template`
(step 5, ~L931-950) rejects a hero→`scene` switch unless a footage `Clip` exists
for that scene index. But a hero scene is shown a **Background** pool, and
picking/uploading a background writes a `background_override` — never a footage
`Clip`. So the footage clip the gate requires can never be created for a stat,
making `scene` permanently disabled (and, today, with no visible reason). The
`scene` template card therefore reads as broken.

## Decision (approved)

**Promote background → footage.** Picking a Background clip un-gates the `scene`
card. Switching to `scene` converts that already-chosen background clip into the
scene's footage. One clip, reused; matches the mental model "make this clip the
whole scene."

## Goals

1. Switching a hero scene to `scene` when a background clip exists succeeds: the
   background clip becomes the scene's footage `Clip`, and the scene renders as a
   footage scene.
2. The `scene` template card is enabled for a hero when a background clip exists
   (`backgroundProvenance != null`), disabled otherwise — and when disabled it
   shows a **visible** reason ("pick a background clip first"). This also fixes
   the invisible-disabled-reason regression.
3. When neither a footage clip nor a background clip exists, the switch is still
   rejected, with a clear message.

## Non-goals

- No change to template eligibility (`scene` stays always-eligible; the gate is a
  renderability guard, not eligibility).
- No new background/footage pool UI; reuse the existing Background pool.
- No cleanup of the now-inert `background_override` after the switch (the `scene`
  template ignores `backgroundClip`; leaving it is harmless). Out of scope.
- No change to footage scenes (`needsFootage` true) — they already work.

## Ground truth (verified)

- **Gate:** `engine._pick_template` L931-950. `_target_needs_footage = manifest.kind
  == "scene" and manifest.consumes != "enumeration"`. If the current scene is a
  hero (`plan.scenes[scene].needs_footage` is False) and no footage Clip has
  `.index == scene`, it raises `assemble: template_override scene N: switching to
  a footage layout needs a footage pick — use the footage pool`.
- **Background override shape** (`_clip_value_from_row`, L632-644 →
  `background_overrides.value`): `{path, query, rank, pexels_id, pexels_url,
  duration_frames, kind}`.
- **Footage `Clip`** (`pipeline/contracts.py`): `{index, query, path,
  duration_frames=None, kind="video", rank=None, pexels_id=None,
  pexels_url=None}` — a near-1:1 superset of the override value (add `index`).
- **Read path:** `store.get_background_overrides(conn, sid)` returns `{scene:
  {value, source, picked_rank, updated_at}}` with `value` already `json.loads`-ed
  to a dict.
- **Footage output bundle:** `{"clips": [Clip], "candidates": {...}, ...}`;
  persisted via `codecs.footage_to_json` / `store.upsert_stage(..., "footage",
  ...)`. `_load_output("footage")` returns the decoded bundle (clips are `Clip`
  dataclasses via `clips_from_json`).
- **Frontend signal:** `SceneState.backgroundProvenance: BackgroundProvenance |
  null` (non-null once a background clip is picked, auto or pinned). The current
  gate var is `heroClipless = !scene.needsFootage && scene.candidates.length === 0`.

## Design

### Backend — `engine._pick_template` (the no-footage branch, ~L938-950)

When the hero has no footage `Clip` for the scene, before raising, look for a
background override and promote it:

```python
# Current scene is a hero with no footage clip. If a background clip exists,
# promote it to this scene's footage (the chosen clip becomes the scene footage);
# only reject if there's no clip to promote.
_footage_out = self._load_output("footage")
_has_clip = (
    _footage_out is not None
    and any(c.index == scene for c in _footage_out.get("clips", []))
)
if not _has_clip:
    overrides = store.get_background_overrides(self.conn, self.sid)
    bg = overrides.get(scene)
    if bg and bg.get("value", {}).get("path"):
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
        bundle["clips"] = [c for c in bundle.get("clips", []) if c.index != scene] + [promoted]
        to_json, _ = CODECS["footage"]
        store.upsert_stage(
            self.conn, self.sid, "footage", status="done",
            input_hash=store.get_stage(self.conn, self.sid, "footage")["input_hash"],
            output_json=json.dumps(to_json(bundle), default=str), now=_now())
    else:
        raise ValueError(
            f"assemble: template_override scene {scene}: pick a background clip "
            f"first, then switch to a scene template")
```

Then fall through to the existing `upsert_template_override(...)`. `edit()` then
invalidates downstream and re-derives the spec, so the scene renders as footage.

Notes:
- Promotion replaces any existing clip at that index (idempotent on re-fire).
- The exact `CODECS["footage"]` / `_load_output` / `upsert_stage` idiom mirrors
  `_edit_assemble` and the auto-fill hook already in this file — follow those.
- `value` is a dict (json-parsed by the store); guard on `value.get("path")`.

### Frontend — `SceneControls.tsx` template gate

- Pass a `hasBackgroundClip` signal into the gate. Source: `scene.backgroundProvenance != null`.
- Change the gate so the `scene` card is enabled for a hero when footage candidates
  exist OR a background clip exists. Concretely, replace the `heroClipless`
  computation with: `heroClipless = !scene.needsFootage && scene.candidates.length === 0 && scene.backgroundProvenance == null`.
- The disabled `scene` card must show a **visible** reason (not only `sr-only`):
  add a small caption/tooltip on the dimmed card, e.g. an always-rendered label
  "needs a clip" plus the existing `sr-only` long reason, or a visible title-style
  line under the card. The reason text: "pick a background clip first".

(The `TemplateCardRail` already computes `gated = t === 'scene' && heroClipless &&
!active`; only the `heroClipless` input and the visible-reason rendering change.)

## Testing

**Backend** (`backend/tests/` — extend the assemble/gate-ops tests):
- Promote: a hero stat scene with a `background_override` and no footage clip →
  `pick_template` to `scene` succeeds, AND a footage `Clip` with `.index == scene`
  now exists carrying the override's path/query/duration/provenance.
- No clip: a hero stat with neither footage clip nor background override →
  `pick_template` to `scene` raises with the new "pick a background clip first"
  message.
- Idempotent / replace: promoting when a clip already exists at that index
  replaces it (no duplicate clips at the same index).
- Existing gate tests (footage scene switch, unknown id, kind) stay green.

**Frontend** (`SceneControls.test.tsx`):
- `scene` card ENABLED (not disabled) when the hero has `backgroundProvenance` set.
- `scene` card DISABLED with a VISIBLE reason when hero has no clip
  (`backgroundProvenance == null`, no candidates).

**Eyes-on (operator merge gate):** on stat scene 04 — pick a Background clip → the
`scene` card enables → click it → the left preview renders a footage scene of that
clip. Capture to `/mnt/user-data/uploads`.

## Files touched

- `backend/session/engine.py` — `_pick_template` promote branch.
- `backend/tests/test_v3_m5_gate_ops.py` (or the closest existing gate-ops test) —
  promote + no-clip + replace tests.
- `preview/components/scenes/SceneControls.tsx` — gate input + visible reason.
- `preview/components/scenes/SceneControls.test.tsx` — enabled/disabled-with-reason tests.

## Risks

- The promoted clip's `path` points at `assets/footage_bg_*.mp4` (already
  downloaded for the background). The render reads from `remotion/public/assets`
  via the copy-assets mirror; the same file already renders as a background, so it
  is present. Verify in eyes-on that the footage scene shows it.
- A stat's `background_override` value with `kind: "image"` (uploaded image bg)
  promotes to an image footage Clip; the `scene` template must render images
  (it already does via the Media image branch). Confirm during eyes-on if an image
  bg is used; videos are the common case.

---

## Parity addendum (2026-06-14) — stat behaves like hook/outro

Approved follow-up after eyes-on: hook/outro auto-fill a background clip
(`HERO_BACKGROUND_POLICY` "auto"), so their `scene` card is enabled out of the
box; a stat keeps its gradient ("gradient" policy, no auto background), so its
`scene` card stayed gated and could only switch after an explicit Background pick.
The user wants the stat to switch in one click like hook/outro. Two changes:

**Backend — auto-promote the top pool candidate when nothing is pinned.** Extend
the `_pick_template` no-footage branch: if there is no pinned/auto
`background_override`, fall back to the scene's **background candidate pool**
(`footage_out["candidates"][scene]`), choose the lowest-rank row (rank 1 = the AI
pick), DOWNLOAD it via `self._download_background_clip(chosen, slug, rank)` (mirrors
`_edit_background` pick, L702-709 — the unpinned candidate isn't on disk yet), build
a footage `Clip` from the downloaded path + the row's `query/duration_frames/rank/
pexels_id/pexels_url`, append it to the footage output. Only raise the "pick a
background clip first" error when there is neither a pinned override NOR any pool
candidate (truly empty). Unify both promote sources (override / pool) so the switch
succeeds whenever any clip is available.

**Frontend — enable the `scene` card when the pool has clips.** Widen the gate so
a hero is "clipless" only when it has no footage candidates AND no pinned background
AND an empty background pool:
`heroClipless = !scene.needsFootage && scene.candidates.length === 0 &&
scene.backgroundProvenance == null && scene.backgroundPool.rows.length === 0`.
So scene 04 (15 pool clips) enables the `scene` card immediately; the visible
"pick a clip" reason now only appears in the genuinely-empty-pool case.

**Tests:** backend — a hero with no pinned override but a non-empty candidate pool
switches to `scene`, auto-promoting the rank-1 candidate into a footage `Clip`
(download stubbed via `pipeline.footage._download`); the truly-empty case
(no override, no candidates) still raises. Frontend — `scene` card ENABLED when
`backgroundPool.rows` is non-empty even with `backgroundProvenance == null`.

**Eyes-on:** on stat scene 04 with the gradient kept — the `scene` card is enabled;
clicking it renders a footage scene of the rank-1 background clip; the footage pool
then lets you swap the clip.
