# Enumeration Visual Treatment — Tier 1 (motion + layout) — design

**Status:** ruled (all decisions decided by the reviewer 2026-06-08); ready for plan → TDD → motion gate.
**Branch:** `enumeration-visual-tier1` (off `development` @ `7d056d1`, the merged Round-3 mechanism / PR #7).
**Predecessor:** [[round3-enumeration-layout]] — its mechanism is signed off; this round is paint over that plumbing.

## 1. Goal

Make the enumeration reveal **move and fill the frame**. The Round-3 gate confirmed the synced one-by-one reveal works but reads as flat emoji bullets on a two-thirds-empty frame (the expected emoji-floor trigger). Tier 1 fixes the *motion* and the *layout* — **zero new dependencies, render-side only** — and is the biggest visible lift. Designed icons + NASA imagery are Tier 2 (next round); 3D is Tier 3 (parked).

## 2. Scope (hold the line)

**This round changes ONLY:** the per-item entrance motion, the active-item highlight, and the layout — i.e. `templates/enumeration/Component.tsx` and `templates/enumeration/reveal.ts` (+ a small sizing helper) and their tests.

**Deliberately UNCHANGED (the plumbing doesn't move):**
- `remotion/src/item-timing.ts` (the onset resolver) and `TemplateProps.itemTimings`
- `Video.tsx` wiring (capability-gated `itemTimings` computation + the synced/fallback split)
- the recipe routing, `manifest.json`, `schema.ts`, the spec contract, caption suppression
- **the emoji icons stay** — `icons.ts` is untouched; Tier 2 replaces it. The Tier-1 gate clip shows *animated, well-laid-out emoji* — you're ruling motion + layout, not icons.

The entrance keys off the **same** per-item reveal start frames the resolver already produces, so the voice-lock is preserved by construction (see §5 gate).

## 3. Decisions (as ruled)

**Motion — per-item entrance.** Overshoot entrance reusing `stat`'s vocabulary (`Easing.out(Easing.back(1.7))`): scale `0.85 → 1` with a back-ease overshoot, a short translate-up settle, and an optional ≤2° rotate-to-0. Start at `stat`'s overshoot magnitude; tune on the gate. `spring()` is the fallback only if the back-ease reads too uniform (a feel call confirmed on the clip).

**Active-item highlight — decays, does not hold.** The just-revealed item gets a transient accent (theme accent color + a small scale bump) that **eases up at its reveal and decays back to the foreground as the next item reveals** — so only the *active* item is lit and the eye tracks the narration. If accents held, all items would end lit and there'd be no focal point. This mirrors the hook's `wordRevealState` accent over a half-open `[start, next)` window. The last item uses a fixed window so the final settled frame has **nothing lit** (all foreground), matching the clean Round-3 end state. **The `reveal.ts` unit test asserts the accent decays, not holds.**

**Layout — single centered column, auto-fit, fills the frame.** A single centered column (not a grid — a grid breaks the one-by-one "next item appears below the last" reading and muddies which row lights). Item rows (icon-left / label-right, upsized) **auto-fit to the item count** — reusing the auto-fit pattern from `hook`'s `heroFontSize` / `stat`'s `valueFontSize` — so the frame is filled at 2 items and the 6-item case is absorbed by **shrinking, not wrapping**. Background drift reuses the existing `heroBackground` breathing.

## 4. Architecture

**`templates/enumeration/reveal.ts`** (evolve the existing `itemRevealState`): a pure
`itemRevealState(frame, startFrame, endFrame)` → `{opacity, scale, translateY, rotate, accent}` where `[startFrame, endFrame)` is the item's active window (`endFrame` = the next item's reveal, or a fixed settle window for the last). Entrance (opacity/scale/translate/rotate) keys off `startFrame` over ~9 frames with back-ease overshoot; `accent` eases up at `startFrame` and decays to 0 by `endFrame`. Remotion-free, unit-tested (gate-matching), like `hook-reveal.ts`.

**`templates/enumeration/sizing.ts`** (new pure helper): `enumerationSizing(itemCount)` → `{iconSize, labelSize, rowGap}` — monotonic non-increasing in `itemCount`, clamped, sized so 6 rows fit the 1920px height without overflow. Unit-tested.

**`templates/enumeration/Component.tsx`** (refactor): compute per-item reveal starts (synced from `itemTimings`, else the even-staggered fallback — unchanged), derive each item's `[start, end)` window, render a centered auto-fit column applying `itemRevealState` + the active accent + `enumerationSizing`. The synced/fallback decision and the `itemTimings` prop are consumed exactly as today.

**Unchanged consumers:** `Video.tsx`, `item-timing.ts`, the recipe, the manifest, the contract, caption suppression.

## 5. Touch-point classification

- **(a) plugin-local:** `reveal.ts` (evolve), `sizing.ts` (new), `Component.tsx` (refactor); tests `enumeration-reveal.test.ts` (extend), `enumeration-sizing.test.ts` (new).
- **(b) gate harness:** extend `backend/scripts/enumeration_gate.py` with a peak-to-trough amplitude readout + a 6-item beat.
- **(c) MUST stay green / untouched:** `item-timing.ts`, `Video.tsx`, recipe routing, `manifest.json`, `schema.ts`, spec contract, `captions-suppress.ts`, the onset resolver, `icons.ts` (emoji). The Round-3 onset-sync and caption-suppress tests must stay green.

## 6. Motion gate

Extend `enumeration_gate.py` and render:
- the canonical **sun/moon/planets/eclipse/phases** clip (voice-locked), and a **6-item** clip (to prove the auto-fit layout fills the frame and absorbs 6 by shrinking);
- the **onset table** (sync regression — items still reveal at their spoken-word frames);
- an **amplitude readout** — peak-to-trough scale/translate per item, per [[measure-motion-by-cycle-amplitude]] — so "it moves" is measured, not asserted.

**Gate metric:** (a) onset-sync regression stays green (motion can't break the voice-lock); (b) amplitude readout shows real entrance swing; (c) the reviewer rules "designed" on the pixels. **Transport:** the reviewer attaches `sync.mp4` + the 6-item clip to chat (a build-box `cp` to `/mnt/user-data/uploads` doesn't reach their container).

## 7. TDD sub-gate sequence

1. **`itemRevealState` (RED→GREEN):** entrance overshoot (scale peaks > 1 then settles to 1), translate/rotate settle, and the **accent decays** over `[start, end)` (lit at `start`, ~0 by `end`); hidden before `start`. Extend `enumeration-reveal.test.ts`.
2. **`enumerationSizing` (RED→GREEN):** monotonic non-increasing sizes by count, clamped, 6-item total height ≤ frame. New `enumeration-sizing.test.ts`.
3. **Component refactor:** centered auto-fit column + per-item window + accent; **onset-sync + caption-suppress regressions stay green**; tsc/vitest/pytest green.
4. **Gate harness extension + motion gate.**

## 8. Workflow

Feature branch `enumeration-visual-tier1` → PR into `development` (operator's manual action) once the gate is signed off. Commits land only on this branch; CC never pushes/PRs/merges. The combined-round off-ramp (fold Tier 2 in) is closed now that the branch is cut — split stands.
