# Scenes Visual Template View + Scrollable Pools — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Scenes-gate template text-chips with a horizontal-scroll row of visual template cards (poster + hover/active video loop), and clamp the footage/background pools to a ~1.5-row vertical scroll — all reusing the existing `pick_template`/`pick` edit ops and the live `ScenePlayer`.

**Architecture:** Frontend-only changes in `preview/components/scenes/SceneControls.tsx`. Two new exported presentational components — `TemplateCardRail` and `ScrollPool` — are unit-tested in isolation (jsdom, raw `react-dom/client`, mirroring `GateInterstitial.strictmode.test.tsx`). Card video loops are gated by `useReducedMotion` (framer-motion, already used in `TemplateCard.tsx`). Stale on-disk preview assets are regenerated first. The motion behaviors (hover/active loop, click→preview swap, scroll, reduced-motion) are validated by a browser eyes-on, which is the merge gate.

**Tech Stack:** Next.js (preview app), React, Tailwind, framer-motion (`useReducedMotion`), vitest + jsdom, Remotion (`gen-previews`).

**Spec:** `docs/superpowers/specs/2026-06-14-scenes-visual-template-view-design.md` (read it, including the "Review addenda" section — items 1–7).

---

## File Structure

- `preview/public/previews/*.jpg|.mp4` + `previews.lock.json` — regenerated (Task 0).
- `preview/app/globals.css` — add `.scrollbar-hide` utility (Task 1).
- `preview/components/scenes/SceneControls.tsx` — add + export `ScrollPool` (Task 1) and `TemplateCardRail` (Task 2); wrap the two pool grids; replace the chip block.
- `preview/components/scenes/SceneControls.test.tsx` — new jsdom render tests for both components (Tasks 1 + 2).

---

## Task 0: Regenerate stale template previews (prerequisite)

The card posters/loops come from `preview/public/previews/<id>.jpg|.mp4`. `gen-previews --dry-run` reports ALL eight templates STALE on this branch (they predate the current renderer). If not regenerated, a card shows a look that no longer matches what the left preview renders on pick. This task has no automated test — its verification is the `--dry-run` output flipping to `fresh`.

**Files:**
- Modify (generated): `preview/public/previews/*.jpg`, `preview/public/previews/*.mp4`, `preview/public/previews/previews.lock.json`

- [ ] **Step 1: Confirm staleness before**

Run: `cd remotion && node scripts/gen-previews.mjs --dry-run`
Expected: eight lines, each ending `STALE` (e.g. `stat a0ec118c69d83ea9 STALE`).

- [ ] **Step 2: Regenerate all previews**

Run: `cd remotion && npm run gen-previews`
Expected: builds the registry, then renders a poster + looping MP4 per template. This invokes Remotion renders and can take several minutes. Watch for a non-zero exit / render error and stop if one occurs.

- [ ] **Step 3: Confirm freshness after**

Run: `cd remotion && node scripts/gen-previews.mjs --dry-run`
Expected: eight lines, each ending `fresh`.

- [ ] **Step 4: Eyeball one regenerated poster**

Run: `cd /home/zain-ali/Documents/AIVideoGenerationTool && git status --short preview/public/previews/`
Expected: modified `*.jpg`, `*.mp4`, and `previews.lock.json`. Open `preview/public/previews/stat.jpg` and confirm it matches the current stat template look (the hero-card background treatment).

- [ ] **Step 5: Commit**

```bash
cd /home/zain-ali/Documents/AIVideoGenerationTool
git add preview/public/previews/
git commit -m "chore(previews): regenerate stale template previews on studio-v3-staged-flow

gen-previews --dry-run reported all 8 templates STALE; refreshed posters+loops
+ previews.lock.json so the new Scenes template cards match the live renderer."
```

---

## Task 1: `ScrollPool` wrapper + `.scrollbar-hide` utility

A thin wrapper that clamps its children to ~1.5 rows with vertical scroll and a bottom fade. Per-breakpoint `max-h` (3-col tiles are taller than 4-col `sm:` tiles, so a single value can't be 1.5 rows at both). Also add the `.scrollbar-hide` utility now (Task 2's horizontal rail needs it; no tailwind scrollbar plugin exists).

**Files:**
- Modify: `preview/app/globals.css` (append utility)
- Modify: `preview/components/scenes/SceneControls.tsx` (add + export `ScrollPool`; wrap the two grids)
- Test: `preview/components/scenes/SceneControls.test.tsx` (create)

- [ ] **Step 1: Add the `.scrollbar-hide` utility to globals.css**

Append to `preview/app/globals.css`:

```css
/* Cross-browser scrollbar hide — used by the Scenes template rail (horizontal)
   and the clamped footage/background pools (vertical). Scroll still works; only
   the visible track is suppressed. */
.scrollbar-hide {
  -ms-overflow-style: none;   /* IE/Edge */
  scrollbar-width: none;      /* Firefox */
}
.scrollbar-hide::-webkit-scrollbar {
  display: none;              /* WebKit */
}
```

- [ ] **Step 2: Write the failing test for `ScrollPool`**

Create `preview/components/scenes/SceneControls.test.tsx`:

```tsx
// @vitest-environment jsdom
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {ScrollPool, TemplateCardRail} from './SceneControls';

(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

// framer-motion's useReducedMotion reads window.matchMedia, which jsdom lacks.
// Default: motion ALLOWED (matches:false). Individual tests can override.
function stubMatchMedia(matches: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  stubMatchMedia(false);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('ScrollPool', () => {
  it('wraps children in a vertical-scroll clamp container', () => {
    act(() => {
      root.render(createElement(ScrollPool, {}, createElement('div', {'data-testid': 'child'}, 'x')));
    });
    const scroller = container.querySelector('[data-scrollpool]') as HTMLElement;
    expect(scroller).toBeTruthy();
    expect(scroller.className).toContain('overflow-y-auto');
    expect(scroller.className).toContain('scrollbar-hide');
    // per-breakpoint clamp present (mobile value + sm: override)
    expect(scroller.className).toMatch(/max-h-\[/);
    expect(scroller.className).toMatch(/sm:max-h-\[/);
    expect(container.querySelector('[data-testid="child"]')).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd preview && npx vitest run components/scenes/SceneControls.test.tsx`
Expected: FAIL — `ScrollPool` is not exported from `./SceneControls` (import error), or no `[data-scrollpool]` element.

- [ ] **Step 4: Implement `ScrollPool` in SceneControls.tsx**

Add near the bottom of `preview/components/scenes/SceneControls.tsx` (exported):

```tsx
// ─── ScrollPool: clamp a pool grid to ~1.5 rows of vertical scroll ──────────
// Per-breakpoint max-h: 3-col tiles (mobile) are taller than 4-col tiles (sm:),
// so 1.5 rows is a different pixel height at each breakpoint. Derivation:
// tileW ≈ (colWidth); tileH = tileW * 16/9; clamp ≈ 1.5*tileH + 0.5*gap.
// Starting values below are validated/tuned in the browser eyes-on (item 7).
export function ScrollPool({children}: {children: React.ReactNode}) {
  return (
    <div className="relative">
      <div
        data-scrollpool
        className="max-h-[260px] sm:max-h-[210px] overflow-y-auto scrollbar-hide"
      >
        {children}
      </div>
      {/* bottom fade — signals more content below the clamp */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-[#0e0e14] to-transparent" />
    </div>
  );
}
```

(If the scene controls background differs, match the existing column background colour in the `from-[...]` stop during eyes-on; the gradient is cosmetic.)

- [ ] **Step 5: Wrap the footage and background grids with `ScrollPool`**

In the Footage section, change:

```tsx
              <PoolGrid
                rows={scene.candidates}
                disabled={busy}
                pending={reopened}
                onPick={(rank) => run('Swapping clip…', () => postEdit(sid, {op: 'pick', scene: scene.index, rank, target: 'footage'}))}
              />
```

to wrap it:

```tsx
              <ScrollPool>
                <PoolGrid
                  rows={scene.candidates}
                  disabled={busy}
                  pending={reopened}
                  onPick={(rank) => run('Swapping clip…', () => postEdit(sid, {op: 'pick', scene: scene.index, rank, target: 'footage'}))}
                />
              </ScrollPool>
```

In the Background section, wrap `<BackgroundGrid .../>` the same way:

```tsx
            <ScrollPool>
              <BackgroundGrid
                rows={scene.backgroundPool.rows}
                isGradient={scene.backgroundProvenance == null}
                disabled={busy}
                pending={reopened}
                onPick={(rank) => run('Swapping background…', () => postEdit(sid, {op: 'pick', scene: scene.index, rank, target: 'background'}))}
              />
            </ScrollPool>
```

(The `poolError` branch above it is left unwrapped — it's a single message, not a grid.)

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd preview && npx vitest run components/scenes/SceneControls.test.tsx`
Expected: PASS (the `ScrollPool` test).

- [ ] **Step 7: Commit**

```bash
cd /home/zain-ali/Documents/AIVideoGenerationTool
git add preview/app/globals.css preview/components/scenes/SceneControls.tsx preview/components/scenes/SceneControls.test.tsx
git commit -m "feat(scenes): clamp footage/background pools to ~1.5-row scroll (ScrollPool)"
```

---

## Task 2: `TemplateCardRail` (visual cards, reduced-motion, a11y, disabled branch)

Replace the text-chip Template block with a horizontal-scroll radiogroup of poster cards. Hover/active plays the loop, gated OFF under reduced motion (item 1). Single-select radio semantics (item 6). The `scene`-on-clipless-hero disabled branch is preserved (item 3 — verified live). Gradient fallback when a preview asset is missing.

**Files:**
- Modify: `preview/components/scenes/SceneControls.tsx` (add + export `TemplateCardRail`; replace chip block; import `useReducedMotion`)
- Test: `preview/components/scenes/SceneControls.test.tsx` (extend)

- [ ] **Step 1: Write the failing tests for `TemplateCardRail`**

Append to `preview/components/scenes/SceneControls.test.tsx`:

```tsx
describe('TemplateCardRail', () => {
  const baseProps = {
    templates: ['scene', 'stat'],
    current: 'stat',
    overridden: false,
    heroClipless: false,
    busy: false,
    onPick: () => {},
  };

  it('renders a radiogroup with one radio card per eligible template', () => {
    act(() => root.render(createElement(TemplateCardRail, baseProps)));
    const group = container.querySelector('[role="radiogroup"]') as HTMLElement;
    expect(group).toBeTruthy();
    expect(group.className).toContain('overflow-x-auto'); // horizontal scroll
    const cards = container.querySelectorAll('[role="radio"]');
    expect(cards.length).toBe(2);
  });

  it('marks the current template aria-checked', () => {
    act(() => root.render(createElement(TemplateCardRail, baseProps)));
    const checked = container.querySelector('[role="radio"][aria-checked="true"]') as HTMLElement;
    expect(checked).toBeTruthy();
    expect(checked.textContent).toContain('stat');
  });

  it('disables the scene card on a clipless hero (eligible-but-gated)', () => {
    act(() => root.render(createElement(TemplateCardRail, {
      ...baseProps, current: 'hook', templates: ['hook', 'scene'], heroClipless: true,
    })));
    const sceneCard = Array.from(container.querySelectorAll('[role="radio"]'))
      .find((el) => el.textContent?.includes('scene')) as HTMLButtonElement;
    expect(sceneCard.disabled).toBe(true);
    // tooltip reaches SR/keyboard users, not just hover
    expect(sceneCard.getAttribute('aria-describedby')).toBeTruthy();
  });

  it('calls onPick with the template id when an enabled non-active card is clicked', () => {
    const onPick = vi.fn();
    act(() => root.render(createElement(TemplateCardRail, {...baseProps, onPick})));
    const sceneCard = Array.from(container.querySelectorAll('[role="radio"]'))
      .find((el) => el.textContent?.includes('scene')) as HTMLButtonElement;
    act(() => sceneCard.click());
    expect(onPick).toHaveBeenCalledWith('scene');
  });

  it('plays no video under reduced motion (poster-only)', () => {
    stubMatchMedia(true); // prefers-reduced-motion: reduce
    act(() => root.render(createElement(TemplateCardRail, baseProps)));
    // active card would otherwise autoplay a loop; under reduced motion none render
    expect(container.querySelector('video')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd preview && npx vitest run components/scenes/SceneControls.test.tsx`
Expected: FAIL — `TemplateCardRail` not exported (import error) and no `[role="radiogroup"]`.

- [ ] **Step 3: Import `useReducedMotion` at the top of SceneControls.tsx**

Change the framer import region near the top of `preview/components/scenes/SceneControls.tsx`. Add:

```tsx
import {useReducedMotion} from 'framer-motion';
```

(Place it with the other top imports, after the `react` import line.)

- [ ] **Step 4: Implement `TemplateCardRail` in SceneControls.tsx**

Add (exported), above `PoolGrid`:

```tsx
// ─── TemplateCardRail: horizontal poster cards, one per eligible template ────
// Poster = /previews/<id>.jpg; hover/active swaps to a muted looping
// /previews/<id>.mp4 — UNLESS reduced motion (item 1: loops are killed). Radio
// semantics (single-select). The 'scene'-on-clipless-hero card is eligible-but-
// gated (item 3): disabled with an SR-reachable reason. Missing asset → gradient.
const TEMPLATE_KIND_GRADIENT: Record<string, string> = {
  hook: 'linear-gradient(160deg,#101631,#5e5ce6)',
  scene: 'linear-gradient(135deg,#0a2540,#0a84ff 70%,#7cc4ff)',
  stat: 'linear-gradient(135deg,#06281e,#30d158 90%)',
  outro: 'linear-gradient(160deg,#1a0d00,#ff9f0a 90%)',
  enumeration: 'linear-gradient(200deg,#33214d,#8b5cf6)',
};

export function TemplateCardRail({
  templates,
  current,
  overridden,
  heroClipless,
  busy,
  onPick,
}: {
  templates: string[];
  current: string;
  overridden: boolean;
  heroClipless: boolean;
  busy: boolean;
  onPick: (t: string) => void;
}) {
  const reducedMotion = useReducedMotion() ?? false;
  const [hovered, setHovered] = useState<string | null>(null);

  return (
    <div role="radiogroup" aria-label="Scene template" className="flex gap-2 overflow-x-auto scrollbar-hide snap-x pb-1">
      {templates.map((t) => {
        const active = t === current;
        const gated = t === 'scene' && heroClipless && !active;
        const disabled = busy || gated;
        const showVideo = !reducedMotion && (active || hovered === t) && !disabled;
        const descId = gated ? `tmpl-${t}-reason` : undefined;
        return (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={`${t} template${active ? ' (selected)' : ''}`}
            aria-describedby={descId}
            disabled={disabled || active}
            onMouseEnter={() => setHovered(t)}
            onMouseLeave={() => setHovered((h) => (h === t ? null : h))}
            onFocus={() => setHovered(t)}
            onBlur={() => setHovered((h) => (h === t ? null : h))}
            onClick={() => onPick(t)}
            className={
              'group relative aspect-[9/16] w-[88px] shrink-0 snap-start overflow-hidden rounded-[var(--radius-sm)] border transition disabled:cursor-not-allowed ' +
              (active
                ? 'border-accent-1 ring-2 ring-accent-1'
                : disabled
                  ? 'border-white/10 opacity-50'
                  : 'border-white/10 hover:border-white/30')
            }
          >
            {showVideo ? (
              <video
                src={`/previews/${t}.mp4`}
                poster={`/previews/${t}.jpg`}
                autoPlay
                loop
                muted
                playsInline
                className="h-full w-full object-cover"
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/previews/${t}.jpg`}
                alt=""
                loading="lazy"
                className="h-full w-full object-cover"
                onError={(e) => {
                  const el = e.currentTarget;
                  el.style.display = 'none';
                  const fb = el.nextElementSibling as HTMLElement | null;
                  if (fb) fb.style.display = 'block';
                }}
              />
            )}
            {/* gradient fallback (revealed by img onError) */}
            <span
              aria-hidden
              className="absolute inset-0 hidden"
              style={{background: TEMPLATE_KIND_GRADIENT[t] ?? 'linear-gradient(135deg,#1b1f3a,#5e5ce6,#a78bfa)'}}
            />
            {/* name + auto tag */}
            <span className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-black/55 px-1.5 py-1 font-ui text-[11px] font-semibold text-white">
              {t}
              {active && !overridden ? <span className="font-mono text-[9px] opacity-80">auto</span> : null}
            </span>
            {gated && (
              <span id={descId} className="sr-only">
                pick a clip first — a scene template needs footage
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 5: Replace the chip block with `TemplateCardRail`**

In the component body, replace the entire Template `<section>` (the `scene.eligibleTemplates.length > 0 && (...)` block with the chip `.map`) with:

```tsx
      {/* ── Template cards (horizontal scroll, poster + hover/active loop) ──── */}
      {scene.eligibleTemplates.length > 0 && (
        <section>
          <Eyebrow className="mb-1.5">Template</Eyebrow>
          <TemplateCardRail
            templates={scene.eligibleTemplates}
            current={currentTemplate}
            overridden={overridden}
            heroClipless={heroClipless}
            busy={busy}
            onPick={(t) => run(`Switching to ${t}…`, () => postEdit(sid, {op: 'pick_template', scene: scene.index, template: t}))}
          />
        </section>
      )}
```

Note (item 5 — gate dependence): `run()` already routes through the §4.1 `intend` gate. At an APPROVED gate the pick applies and `onChanged()` refreshes the live spec so the left `ScenePlayer` swaps to the real footage immediately. At a REOPENED gate the existing deferral applies — the toast reads "Queued — applies on Re-approve" and the player keeps the current clip until Re-approve. No new code; this matches the existing pool-pick behavior.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd preview && npx vitest run components/scenes/SceneControls.test.tsx`
Expected: PASS — all `ScrollPool` + `TemplateCardRail` tests green.

- [ ] **Step 7: Typecheck**

Run: `cd preview && npx tsc --noEmit`
Expected: no errors. (If `React.ReactNode` is unresolved in `ScrollPool`, ensure `import type {ReactNode} from 'react'` or use the existing React import; adjust to match the file's import style.)

- [ ] **Step 8: Commit**

```bash
cd /home/zain-ali/Documents/AIVideoGenerationTool
git add preview/components/scenes/SceneControls.tsx preview/components/scenes/SceneControls.test.tsx
git commit -m "feat(scenes): visual template card rail — poster+loop, reduced-motion gate, radio a11y

Replaces the template text-chips with a horizontal-scroll radiogroup of poster
cards; hover/active plays the looping preview (off under reduced motion); the
scene-on-clipless-hero card stays eligible-but-gated with an SR-reachable reason."
```

---

## Task 3: Motion eyes-on (merge gate, manual)

This gate is motion; stills do not settle it. jsdom covers structure/wiring only. This task is the merge gate (item 7).

**No files. Verification only.**

- [ ] **Step 1: Run the full preview test + typecheck**

Run: `cd preview && npx vitest run && npx tsc --noEmit`
Expected: all green.

- [ ] **Step 2: Start the preview app and open scene 04**

Run the dev server (per the project's run pattern) and open
`http://localhost:3000/video/v3-54fc4f223e5d452dbad0d512eb454b0b/scenes`, expand scene 04.

- [ ] **Step 3: Capture the motion review**

Record a screen capture and save it to `/mnt/user-data/uploads`, showing:
1. Hover a template card → its loop plays.
2. The active card loops.
3. Click a different eligible card → the LEFT preview swaps to the real footage for that template.
4. The footage/background pool showing ~1.5 rows with vertical scroll.
5. A Reduce-Motion pass (OS `prefers-reduced-motion: reduce`) → cards are poster-only, no loops.

- [ ] **Step 4: Tune the clamp if needed**

If the pool shows materially more or less than ~1.5 rows at either the 3-col (mobile) or 4-col (`sm:`) breakpoint, adjust the `max-h-[260px] sm:max-h-[210px]` values in `ScrollPool`, re-run `npx vitest run components/scenes/SceneControls.test.tsx`, and re-capture. Commit any tuning:

```bash
git add preview/components/scenes/SceneControls.tsx
git commit -m "fix(scenes): tune pool 1.5-row clamp per breakpoint from eyes-on"
```

- [ ] **Step 5: Hand the capture to the operator for the motion ruling.** Merge only after the operator confirms the five behaviors on real pixels.

---

## Self-Review

**Spec coverage:**
- Template view (cards, horizontal scroll, poster+hover/active video) → Task 2. ✓
- Select → real footage in left preview → Task 2 Step 5 (existing `run`/`onChanged`). ✓
- Pools ~1.5-row vertical scroll → Task 1. ✓
- (1) Reduced motion gates loops → Task 2 (`showVideo` guard + reduced-motion test). ✓
- (2) Per-breakpoint clamp → Task 1 (`max-h-[..] sm:max-h-[..]`, test asserts both). ✓
- (3) heroClipless disabled branch live → Task 2 (disabled test). ✓
- (4) Regenerate stale previews → Task 0. ✓
- (5) Gate-dependence stated → Task 2 Step 5 note. ✓
- (6) Radio a11y + SR-reachable tooltip → Task 2 (`role=radio`/`aria-checked`/`aria-describedby` + test). ✓
- (7) Motion eyes-on merge gate → Task 3. ✓

**Placeholder scan:** No TBD/TODO; all steps carry concrete code/commands.

**Type consistency:** `TemplateCardRail` props (`templates/current/overridden/heroClipless/busy/onPick`) match both the test and the call site in Task 2 Step 5. `ScrollPool` takes `children` only; call sites wrap the existing grids. `onPick(t: string)` is wired to the existing `postEdit({op:'pick_template', template: t})`.
