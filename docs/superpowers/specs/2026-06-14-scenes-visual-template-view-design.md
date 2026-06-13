# Scenes gate: visual template view + scrollable pools

**Date:** 2026-06-14
**Branch:** `studio-v3-staged-flow`
**Surface:** `preview/components/scenes/SceneControls.tsx` (Scenes gate controls column)
**Type:** Frontend-only UI enhancement. No backend, schema, or API changes.

## Problem

On the Scenes gate, a scene's template selector is a row of small text chips
(`scene`, `stat`). Users do not recognize it as the template selector ("there
are no template selection available here") and it gives no sense of what each
template looks like. Separately, the footage/background pool is a wrapping grid
that expands the page; it does not read as a scrollable list of options.

This work came out of a director-chat bug investigation: free-text template
changes via the Assemble director are fragile (the LLM hallucinated a `clip`
template). The Scenes gate template chips are the correct, eligibility-gated
surface — so making them obvious and visual is the right fix, and steers users
away from the fragile chat path.

## Goals

1. Replace the text chips with a **horizontal-scroll row of visual template
   cards**, each showing the template's look, so selection is obvious and
   informative.
2. Selecting a card **commits the change** (existing `pick_template` edit) and
   the **left live preview updates to show this scene with real footage** —
   the "see it in real time" behavior.
3. Make the **footage and background pools scrollable**, showing ~1.5 rows so
   the next row half-peeks (signals "scroll for more") instead of expanding the
   page.

## Non-goals

- No backend/edit-op changes. Reuse `pick_template` and `pick`.
- No new rendering. Reuse the pre-rendered preview assets in
  `preview/public/previews/` (`<id>.jpg` poster + `<id>.mp4` loop).
- No change to template eligibility. Cards still render **eligible-only**
  (`scene.eligibleTemplates`) — this is the guard that keeps invalid templates
  unselectable. Ineligible templates do not appear.
- No live per-card rendering (would mount one Remotion player per card and
  conflict with the player mount budget).

## Existing context (ground truth)

- `SceneControls` (`preview/components/scenes/SceneControls.tsx`) renders, in
  order: Template chips, Footage pool (`needsFootage`) or Background pool
  (hero), Transition chips. Picks go through `postEdit` →
  `/api/session/{sid}/edit` with `{op: 'pick_template' | 'pick', ...}`, wrapped
  in `run()` (the §4.1 `intend` edit-gate) → `onChanged()` refreshes the live
  spec → the left `ScenePlayerClient` re-renders.
- `SceneState` (`preview/lib/studio.ts`) provides `eligibleTemplates: string[]`,
  `template: string`, `templateOverride: {value,...} | null`,
  `needsFootage: boolean`, `candidates: Candidate[]`,
  `backgroundPool: {rows: Candidate[]; poolError}`. `Candidate` has
  `{rank, thumbUrl, selected, ...}`.
- Preview assets already on disk: `preview/public/previews/<id>.jpg` and
  `<id>.mp4` for `hook, scene, stat, outro, enumeration, fade, slide, overlay`
  (see `previews.lock.json`). Served statically from `/previews/<id>.jpg`.
- Scenes page layout is a grid
  `lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)]`: the ~300px live
  `ScenePlayerClient` on the left, `SceneControls` on the right.

## Design

### Components (all in `SceneControls.tsx`)

Extract two small presentational components in the same file; leave the existing
pick/gate wiring untouched.

**`TemplateCardRail`** — replaces the `eligibleTemplates.map(...)` chip block.
- Props: `templates: string[]`, `current: string`, `overridden: boolean`,
  `heroClipless: boolean`, `busy: boolean`, `onPick: (t: string) => void`.
- Renders a horizontal scroller: `flex gap-2 overflow-x-auto` with scroll-snap
  (`snap-x`), hidden scrollbar, each card `shrink-0 snap-start`.
- Each card (~96px wide, 9:16 aspect):
  - Background poster `<img src={/previews/${t}.jpg}>`, `object-cover`.
  - A muted, `loop`, `playsInline` `<video src={/previews/${t}.mp4}>` layered on
    top, hidden by default; shown and `.play()` on hover and when the card is
    active. Pause + reset when not hovered/active (keeps it light).
  - Name label (bottom), `auto` tag when `active && !overridden`.
  - Active card: accent ring (`border-accent-1 ring-2 ring-accent-1`).
  - Disabled (`busy`, or `t === 'scene' && heroClipless && !active`): dimmed,
    poster-only (no hover video), existing tooltip ("pick a clip first — a scene
    template needs footage"), `disabled` + `cursor-not-allowed`.
  - Click (when enabled and not active) → `onPick(t)` which the parent wires to
    the existing `run('Switching to ${t}…', () => postEdit(..., {op:
    'pick_template', scene: index, template: t}))`.
- Asset fallback: if the poster image fails to load (`onError`), swap to a
  kind-tone gradient placeholder behind the name label (no broken image, no
  video attempted).

**`ScrollPool`** — a thin wrapper placed around the existing `PoolGrid` and
`BackgroundGrid` render sites.
- Props: `children`.
- Renders `<div class="relative">` containing a scroll container
  `overflow-y-auto` with a `max-height` tuned to ~1.5 tile rows, plus a bottom
  fade overlay (`pointer-events-none` gradient) to signal more content.
- The grids themselves are unchanged (`grid grid-cols-3 sm:grid-cols-4 gap-2`,
  9:16 tiles). The max-height is derived so 1.5 rows are visible: with a 3-col
  grid in a ~1fr column, tile height ≈ (containerWidth/3)*(16/9); the clamp is a
  `max-h-[...]` value tuned during eyes-on (start ~ one tile height × 1.6, incl.
  the row gap). If the pool has ≤ one row, the container shrinks to content (no
  forced empty scroll area).

### Behavior / data flow (unchanged backend)

1. User clicks a template card → `run()` opens the §4.1 intent sheet (at an
   approved gate) → `postEdit({op:'pick_template'})` → `onChanged()` reloads the
   session state and live spec.
2. The left `ScenePlayerClient`, bound to the scene span on the live spec,
   re-renders showing the scene in the new template with its real footage.
3. At a reopened gate, picks remain deferred exactly as today (the existing
   `reopened`/pending affordance is unchanged; it applies to pool picks; a
   template pick uses the same `run`/toast path).

### Error / edge handling

- Missing preview asset → gradient placeholder + name (graceful).
- A single eligible template → one card, no horizontal overflow (fine).
- `busy` → all cards disabled (matches current chip behavior).
- Hover video autoplay is best-effort; a rejected `play()` promise is swallowed
  (poster stays). No audio (muted) so no autoplay-policy block.

## Testing

**jsdom render tests** (repo already supports this — see
`GateInterstitial.strictmode.test.tsx`, vitest + jsdom). New
`SceneControls.test.tsx`:
- Renders one template card per `eligibleTemplates` entry.
- Active template card carries the selected/active state (accent ring class or
  `aria-pressed`).
- A disabled template (`scene` + `heroClipless`) renders `disabled`.
- Each pool render site is wrapped by the `ScrollPool` clamp container (assert
  the overflow/clamp class is present).
- Clicking an enabled, non-active card calls the pick handler with that
  template id.

**Eyes-on** (per the project's visual-gate rhythm) on real scene 04 of
`v3-54fc...`: cards render with posters, hover plays the loop, selecting updates
the left preview with real footage, and the pools show ~1.5 rows with vertical
scroll. Capture hero frames before merge.

## Files touched

- `preview/components/scenes/SceneControls.tsx` — add `TemplateCardRail` +
  `ScrollPool`; replace the chip block; wrap the two pool grids.
- `preview/components/scenes/SceneControls.test.tsx` — new render tests.
- Possibly a small CSS utility for hidden scrollbar (Tailwind arbitrary or an
  existing util) — confirm during implementation.

## Risks

- 1.5-row `max-height` is pixel-tuned; needs eyes-on to land precisely across
  the responsive breakpoints (3-col vs 4-col). Mitigation: derive from tile
  aspect + gap, verify in browser.
- Many hover videos could be heavy if a scene had many eligible templates; in
  practice eligibility caps this at 2-3, and only the hovered/active card plays.
