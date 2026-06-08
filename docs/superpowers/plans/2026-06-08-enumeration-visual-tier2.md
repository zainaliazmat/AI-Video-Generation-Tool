# Enumeration Visual Tier 2 — Image-as-hero Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the emoji enumeration floor with an image-as-hero treatment — a large curated NASA public-domain image (or lucide line-icon fallback) per active beat, plus a persistent running list that preserves the 1·2·3 count.

**Architecture:** Paint over the frozen Round-3/Tier-1 plumbing (voice-lock, `itemRevealState`, auto-fit, caption suppression all untouched). Two zones: a hero zone showing the active item's media via a source-swappable `resolveMedia` cascade (image→icon→mark), and a running list showing every revealed item with the active one emphasized. Pure helpers are TDD'd in vitest; the visual Component is verified at the render gate.

**Tech Stack:** Remotion 4.0.472, React 19, TypeScript, vitest. New dep: `lucide-react` (ISC). Gate harness in Python (`backend/scripts/enumeration_gate.py`).

**Spec:** `docs/superpowers/specs/2026-06-08-enumeration-visual-tier2-design.md`

**Commands (run from `remotion/`):**
- Single test file: `npx vitest run src/<name>.test.ts`
- Full unit suite: `npm run test`
- Typecheck: `npm run typecheck`

---

## Task 0: Prerequisites (gating — do NOT start the build before these)

**This plan's build is gated. Confirm all three before Task 1:**

- [ ] **Step 1: Tier-1 punch-up is merged into `development`**

The Tier-1 punch-up commit `f3c7ae0` (on `enumeration-visual-tier1`) must be merged into `development` by the operator. NEVER merge to master; development is operator-owned. Confirm:

Run: `git log --oneline development | grep -q f3c7ae0 && echo MERGED || echo NOT-YET`
Expected: `MERGED`

- [ ] **Step 2: Cut the Tier-2 branch off `development`**

Run: `git checkout development && git pull && git checkout -b enumeration-visual-tier2`
Expected: on a new branch `enumeration-visual-tier2` whose tip is the merged `development`.

- [ ] **Step 3: Commit the design + plan docs as the branch's first commit**

The spec and this plan are already written to disk (held uncommitted until the branch existed). Commit them now:

```bash
git add docs/superpowers/specs/2026-06-08-enumeration-visual-tier2-design.md \
        docs/superpowers/plans/2026-06-08-enumeration-visual-tier2.md
git commit -m "docs(tier2): image-as-hero enumeration — design + implementation plan

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 1: Add the lucide-react dependency

**Files:**
- Modify: `remotion/package.json` (dependencies)

- [ ] **Step 1: Install lucide-react (project-local, pinned)**

Run: `cd remotion && npm install lucide-react@^0.460.0`
Expected: `lucide-react` appears under `dependencies` in `remotion/package.json`; `package-lock.json` updated.

- [ ] **Step 2: Verify it imports under the Remotion toolchain**

Run: `cd remotion && node -e "require('lucide-react'); console.log('ok')"`
Expected: `ok` (no resolution error).

- [ ] **Step 3: Commit**

```bash
git add remotion/package.json remotion/package-lock.json
git commit -m "build(tier2): add lucide-react (ISC) for designed enumeration icons

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Export `candidates()` from icons.ts

The new resolver reuses the plural-folding helper. It is currently private.

**Files:**
- Modify: `templates/enumeration/icons.ts:30`
- Test: `remotion/src/enumeration-media.test.ts` (created in Task 3; this task only changes the export)

- [ ] **Step 1: Add `export` to the `candidates` function**

In `templates/enumeration/icons.ts`, change:
```ts
function candidates(k: string): string[] {
```
to:
```ts
export function candidates(k: string): string[] {
```

- [ ] **Step 2: Typecheck**

Run: `cd remotion && npm run typecheck`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add templates/enumeration/icons.ts
git commit -m "refactor(tier2): export candidates() for reuse by the media resolver

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `resolveMedia` cascade + manifest + icon-map (+ invariant test)

**Files:**
- Create: `templates/enumeration/media.ts`
- Create: `remotion/src/enumeration-media.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `remotion/src/enumeration-media.test.ts`:
```ts
import {describe, it, expect} from 'vitest';
import {resolveMedia, iconNameFor, IMAGE_MANIFEST, ICON_MAP} from '../../templates/enumeration/media';

describe('resolveMedia cascade', () => {
  it('resolves a curated image label to an image (with alt = original label)', () => {
    const r = resolveMedia('Sun');
    expect(r.kind).toBe('image');
    if (r.kind === 'image') {
      expect(r.src).toBe(IMAGE_MANIFEST['sun']);
      expect(r.alt).toBe('Sun');
    }
  });
  it('folds plurals to the singular image key (Planets -> planet)', () => {
    const r = resolveMedia('Planets');
    expect(r.kind).toBe('image');
    if (r.kind === 'image') expect(r.src).toBe(IMAGE_MANIFEST['planet']);
  });
  it('falls to a lucide icon for an icon-only label (Telescope)', () => {
    const r = resolveMedia('Telescope');
    expect(r).toEqual({kind: 'icon', name: 'telescope'});
  });
  it('falls to a neutral mark for an unknown label', () => {
    const r = resolveMedia('Xyzzy');
    expect(r).toEqual({kind: 'mark'});
  });
  it('INVARIANT: every image-manifest key has an icon-map key (image rows never show a blank mark)', () => {
    const missing = Object.keys(IMAGE_MANIFEST).filter((k) => !(k in ICON_MAP));
    expect(missing).toEqual([]);
  });
});

describe('iconNameFor (icon-layer-only resolve, for list rows of image items)', () => {
  it('returns the icon name for an image label (the list row of a hero image)', () => {
    // Sun resolves to an image in resolveMedia, but its LIST row needs the icon name.
    expect(iconNameFor('Sun')).toBe('sun');
    expect(iconNameFor('Planets')).toBe('orbit'); // plural-folds to planet -> orbit
  });
  it('returns null for a label with no icon-map entry', () => {
    expect(iconNameFor('Xyzzy')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd remotion && npx vitest run src/enumeration-media.test.ts`
Expected: FAIL — cannot resolve module `../../templates/enumeration/media`.

- [ ] **Step 3: Write the minimal implementation**

Create `templates/enumeration/media.ts`:
```ts
/**
 * Source-swappable media resolver for the enumeration hero. Cascade:
 * curated NASA PD image -> designed lucide icon -> neutral mark. The image and
 * icon SOURCES are plain maps so vendoring an icon subset or swapping the image
 * set later is a localized change. Pure + deterministic -> unit-tested. Reuses
 * the plural-folding candidates() from icons.ts. See media design doc Tier 2.
 *
 * INVARIANT (asserted in the test): every IMAGE_MANIFEST key MUST also be an
 * ICON_MAP key. An image item's LIST row renders a small icon (not a thumbnail),
 * so a missing icon-map entry would show a blank mark under a full hero image.
 */
import {candidates} from './icons';

export type LucideName =
  | 'sun' | 'moon' | 'orbit' | 'globe' | 'circle' | 'star' | 'sparkle'
  | 'telescope' | 'rocket' | 'satellite' | 'cloud' | 'droplet' | 'flame'
  | 'waves' | 'mountain' | 'trees' | 'leaf' | 'clock' | 'cog' | 'lightbulb'
  | 'book-open' | 'brain' | 'heart';

export type MediaResolution =
  | {kind: 'image'; src: string; alt: string}
  | {kind: 'icon'; name: LucideName}
  | {kind: 'mark'};

// label -> bundled NASA PD image, as a staticFile() path under remotion/public/.
// The operator drops the confirmed-PD files; provenance lives in assets/CREDITS.json.
export const IMAGE_MANIFEST: Record<string, string> = {
  sun: 'enumeration/sun.jpg',
  moon: 'enumeration/moon.jpg',
  planet: 'enumeration/planets.jpg',
  eclipse: 'enumeration/eclipse.jpg',
  phase: 'enumeration/phases.jpg',
};

// label -> lucide icon name. MUST be a superset of IMAGE_MANIFEST keys (invariant).
export const ICON_MAP: Record<string, LucideName> = {
  sun: 'sun', moon: 'moon', planet: 'orbit', earth: 'globe', mars: 'circle',
  eclipse: 'circle', phase: 'moon', star: 'star', comet: 'sparkle', meteor: 'sparkle',
  galaxy: 'sparkle', telescope: 'telescope', rocket: 'rocket', satellite: 'satellite',
  cloud: 'cloud', rain: 'droplet', water: 'droplet', ocean: 'waves',
  mountain: 'mountain', tree: 'trees', leaf: 'leaf', clock: 'clock',
  gear: 'cog', light: 'lightbulb', book: 'book-open', brain: 'brain', heart: 'heart',
};

export function resolveMedia(label: string): MediaResolution {
  const k = label.trim().toLowerCase();
  for (const c of candidates(k)) {
    if (IMAGE_MANIFEST[c]) return {kind: 'image', src: IMAGE_MANIFEST[c], alt: label};
  }
  const name = iconNameFor(label);
  if (name) return {kind: 'icon', name};
  return {kind: 'mark'};
}

/** Icon-layer-only resolve: the lucide name for a label, or null. Used for the LIST
 *  row of an image item (which shows a small icon, never the big image). The
 *  imageManifest ⊆ iconMap invariant guarantees this is non-null for every image
 *  label, so an image row never falls to a blank mark. */
export function iconNameFor(label: string): LucideName | null {
  const k = label.trim().toLowerCase();
  for (const c of candidates(k)) {
    if (ICON_MAP[c]) return ICON_MAP[c];
  }
  return null;
}

/** kebab LucideName -> PascalCase key in lucide-react's `icons` registry. Lives here
 *  (pure) so both LucideGlyph and the lucide-registry test use the SAME mapping. */
export function toPascal(name: string): string {
  return name.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd remotion && npx vitest run src/enumeration-media.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add templates/enumeration/media.ts remotion/src/enumeration-media.test.ts
git commit -m "feat(tier2): resolveMedia cascade (image->icon->mark) + icon-map invariant

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `heroState` — activeIndex + bounded-crossfade presence

**Files:**
- Create: `templates/enumeration/heroState.ts`
- Create: `remotion/src/enumeration-herostate.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `remotion/src/enumeration-herostate.test.ts`:
```ts
import {describe, it, expect} from 'vitest';
import {activeIndex, heroPresence} from '../../templates/enumeration/heroState';

const STARTS = [30, 50, 70, 90, 110]; // 20-frame gaps (~0.67s at 30fps), the tight beat

describe('activeIndex', () => {
  it('is -1 before the first reveal', () => {
    expect(activeIndex(0, STARTS)).toBe(-1);
  });
  it('is the last item whose start has passed', () => {
    expect(activeIndex(55, STARTS)).toBe(1); // sun(0) revealed, moon(1) active
    expect(activeIndex(200, STARTS)).toBe(4); // last item holds to the end
  });
});

describe('heroPresence', () => {
  it('is 0 before the item reveals', () => {
    expect(heroPresence(20, 1, STARTS)).toBe(0);
  });
  it('is fully present mid-window (after its entrance, before the next reveal)', () => {
    expect(heroPresence(68, 1, STARTS)).toBeCloseTo(1, 5); // moon settled, planets not yet
  });
  it('crossfade completes WITHIN the tight gap and never leaves two heroes fully opaque', () => {
    for (let f = 30; f <= 130; f++) {
      const full = STARTS.map((_, i) => heroPresence(f, i, STARTS)).filter((p) => p > 0.999);
      expect(full.length).toBeLessThanOrEqual(1); // at most one hero at full opacity
    }
  });
  it('the last item stays present to the end (no next item to fade it out)', () => {
    expect(heroPresence(300, 4, STARTS)).toBeCloseTo(1, 5);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd remotion && npx vitest run src/enumeration-herostate.test.ts`
Expected: FAIL — cannot resolve module `../../templates/enumeration/heroState`.

- [ ] **Step 3: Write the minimal implementation**

Create `templates/enumeration/heroState.ts`:
```ts
/**
 * Which item is the hero, and its crossfade opacity. The active item is the last
 * one whose reveal frame has passed. As the next item reveals, the outgoing hero
 * fades out while the incoming one fades/punches in. The fade windows are BOUNDED
 * to the tightest item gap so a crossfade always completes inside a gap and two
 * heroes are NEVER fully opaque at once (asserted in the test against a 20-frame
 * beat). Pure -> unit-tested. Entrance overshoot itself is reused from reveal.ts
 * in the Component; this module only decides which hero is visible and how much.
 */
const ENTER = 10; // matches reveal.ts entrance length

function clamp01(t: number): number {
  return Math.min(1, Math.max(0, t));
}

/** Largest i with starts[i] <= frame; -1 if nothing revealed yet. */
export function activeIndex(frame: number, starts: number[]): number {
  let idx = -1;
  for (let i = 0; i < starts.length; i++) {
    if (starts[i] <= frame) idx = i;
    else break;
  }
  return idx;
}

/** 0..1 opacity for item i's hero. Up-ramp at starts[i], down-ramp at starts[i+1],
 *  each bounded to min(ENTER, gap) so the crossfade fits the tightest gap. */
export function heroPresence(frame: number, i: number, starts: number[]): number {
  if (frame < starts[i]) return 0;
  const hasNext = i + 1 < starts.length;
  const nextStart = hasNext ? starts[i + 1] : Infinity;
  const gapIn = i > 0 ? starts[i] - starts[i - 1] : ENTER;
  const gapOut = hasNext ? nextStart - starts[i] : ENTER;
  const up = clamp01((frame - starts[i]) / Math.max(1, Math.min(ENTER, gapIn)));
  const down = hasNext ? clamp01((frame - nextStart) / Math.max(1, Math.min(ENTER, gapOut))) : 0;
  return clamp01(up - down);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd remotion && npx vitest run src/enumeration-herostate.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add templates/enumeration/heroState.ts remotion/src/enumeration-herostate.test.ts
git commit -m "feat(tier2): heroState — activeIndex + bounded-crossfade presence

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Re-point `enumerationSizing` at the list band

The running list lives in the remainder band (`1 − HERO_BAND_FRACTION`, minus padding), not the full frame. The auto-fit must size against that band — via one shared `listBandHeight()` helper read by both the Component and the test — so six rows don't bleed into the hero and the test guards the exact band the Component renders.

**Files:**
- Modify: `templates/enumeration/sizing.ts`
- Modify: `remotion/src/enumeration-sizing.test.ts` (existing — adjust expectations)

- [ ] **Step 1: Read the existing sizing test to learn the current contract**

Run: `cat remotion/src/enumeration-sizing.test.ts`
Note: the contract is monotonic-shrink + no-overflow. We keep that shape but add a `bandHeight` parameter so the list sizes to its band. Existing call sites pass the full height; update them to the band.

- [ ] **Step 2: Write the failing test**

The test and the Component MUST size against the SAME band, or the test guards a band the Component doesn't use. Both go through `listBandHeight()`. Add to `remotion/src/enumeration-sizing.test.ts`:
```ts
import {enumerationSizing, listBandHeight} from '../../templates/enumeration/sizing';

describe('enumerationSizing list-band fit', () => {
  const BAND = listBandHeight(); // the SAME helper the Component feeds enumerationSizing

  it('fits 6 rows within the band height (icon + gap stack does not overflow)', () => {
    const sz = enumerationSizing(6, BAND);
    const stack = 6 * sz.iconSize + 5 * sz.rowGap;
    expect(stack).toBeLessThanOrEqual(BAND);
  });
  it('still shrinks monotonically as items increase', () => {
    const a = enumerationSizing(2, BAND);
    const b = enumerationSizing(6, BAND);
    expect(b.iconSize).toBeLessThan(a.iconSize);
    expect(b.labelSize).toBeLessThan(a.labelSize);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd remotion && npx vitest run src/enumeration-sizing.test.ts`
Expected: FAIL — `listBandHeight` is not exported / `enumerationSizing` takes one arg.

- [ ] **Step 4: Add the shared band helper + update `enumerationSizing`**

In `templates/enumeration/sizing.ts`, add the single source-of-truth band constants at the top (these resolve the 58/42 split in ONE place — the value is gate-tunable, but the Component and test both read it here):
```ts
// The hero owns the top fraction; the running list gets the remainder minus padding.
// ONE source of truth so the Component's sizing call and the sizing test never diverge.
export const HERO_BAND_FRACTION = 0.58;
const LIST_VPAD = 120; // vertical padding inside the list band (top+bottom)

export function listBandHeight(totalHeight = 1920): number {
  return Math.round(totalHeight * (1 - HERO_BAND_FRACTION)) - LIST_VPAD;
}
```
Then replace the body of `enumerationSizing` with:
```ts
export function enumerationSizing(itemCount: number, bandHeight: number): EnumerationSizing {
  const n = Math.max(2, Math.min(6, itemCount));
  // Budget the band across n rows + (n-1) gaps; gap is ~0.4 of a row.
  const perRow = bandHeight / (n + (n - 1) * 0.4);
  const iconSize = Math.floor(Math.min(perRow, 200)); // cap so few items don't balloon
  return {
    iconSize,
    labelSize: Math.round(iconSize * 0.52),
    rowGap: Math.round(iconSize * 0.4),
  };
}
```
Update the doc comment above `enumerationSizing` to say it fits the supplied band height (not the full frame).

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd remotion && npx vitest run src/enumeration-sizing.test.ts`
Expected: PASS (existing + 2 new).

- [ ] **Step 6: Commit**

```bash
git add templates/enumeration/sizing.ts remotion/src/enumeration-sizing.test.ts
git commit -m "feat(tier2): re-point enumerationSizing at the list-band height

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `LucideGlyph` wrapper component

A thin tintable wrapper over lucide-react. Renders by dynamic name so the resolver can pass a `LucideName`.

**Files:**
- Create: `templates/enumeration/LucideGlyph.tsx`
- Create: `remotion/src/enumeration-lucide.test.ts`

- [ ] **Step 1: Write the failing registry-coverage test**

A renamed/typo'd lucide name currently degrades to a silent invisible span. Catch it at test time, parallel to the icon-map invariant. Create `remotion/src/enumeration-lucide.test.ts`:
```ts
import {describe, it, expect} from 'vitest';
import {icons} from 'lucide-react';
import {ICON_MAP, toPascal} from '../../templates/enumeration/media';

describe('lucide registry coverage', () => {
  it('every ICON_MAP name resolves to a real lucide component (no silent invisible icons)', () => {
    const unresolved = Object.values(ICON_MAP).filter((name) => !(toPascal(name) in icons));
    expect(unresolved).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd remotion && npx vitest run src/enumeration-lucide.test.ts`
Expected: FAIL — cannot resolve `LucideGlyph`'s sibling? No — this test only imports `media` + `lucide-react`, both of which exist by now. It will PASS if every name in `ICON_MAP` is a real lucide icon, and FAIL listing any bad name. Run it; if it fails, fix the offending `ICON_MAP` value in `media.ts` to a real lucide name (check at https://lucide.dev/icons) and re-run until green. (This is a guard test, not red-green TDD — its job is to catch a bad name, so a green run here is success.)

- [ ] **Step 3: Write the LucideGlyph implementation**

Create `templates/enumeration/LucideGlyph.tsx`:
```tsx
import React from 'react';
import {icons} from 'lucide-react';
import type {LucideName} from './media';
import {toPascal} from './media';

/**
 * Tintable lucide icon by name. lucide-react exposes a name->component registry as
 * `icons` with PascalCase keys; toPascal (shared with the registry test) maps our
 * kebab `LucideName` to that. `color` drives the stroke (currentColor under the
 * hood) so the theme palette tints it. Falls back to an empty box if a name is
 * somehow absent — but the registry-coverage test guarantees that never happens
 * for any ICON_MAP value, so this is belt-and-suspenders only.
 */
export const LucideGlyph: React.FC<{name: LucideName; size: number; color: string}> = ({
  name,
  size,
  color,
}) => {
  const Cmp = (icons as Record<string, React.ComponentType<{size: number; color: string; strokeWidth: number}>>)[
    toPascal(name)
  ];
  if (!Cmp) return <span style={{width: size, height: size, display: 'inline-block'}} />;
  return <Cmp size={size} color={color} strokeWidth={1.75} />;
};
```

- [ ] **Step 4: Typecheck + re-run the registry test**

Run: `cd remotion && npm run typecheck && npx vitest run src/enumeration-lucide.test.ts`
Expected: no type errors (lucide-react ships its own types); registry test PASS.

- [ ] **Step 5: Commit**

```bash
git add templates/enumeration/LucideGlyph.tsx remotion/src/enumeration-lucide.test.ts
git commit -m "feat(tier2): LucideGlyph + registry-coverage test (no silent invisible icons)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Rewrite `Component.tsx` into hero zone + running list

Visual task — verified by typecheck here and at the render gate (Task 9), not by a unit test. Reuses `itemRevealState` (entrance), `resolveMedia` (cascade), `heroState` (active/crossfade), `enumerationSizing` (list band), `LucideGlyph`.

**Files:**
- Modify: `templates/enumeration/Component.tsx` (full rewrite of the body)

- [ ] **Step 1: Rewrite the component**

Replace `templates/enumeration/Component.tsx` with:
```tsx
import React from 'react';
import {AbsoluteFill, Img, staticFile, useCurrentFrame} from 'remotion';
import type {TemplateProps} from '../sdk';
import type {EnumerationData} from './schema';
import {heroBackground, HERO_BREATH_PERIOD} from '../heroBackground';
import {resolveMedia, iconNameFor} from './media';
import {LucideGlyph} from './LucideGlyph';
import {itemRevealState} from './reveal';
import {activeIndex, heroPresence} from './heroState';
import {enumerationSizing, listBandHeight, HERO_BAND_FRACTION} from './sizing';

/**
 * `enumeration` — Tier 2 image-as-hero. Each item's beat is presented big in a HERO
 * zone (curated NASA PD image, else a large lucide icon, else a mark) keyed to the
 * voice-locked onset; the active hero crossfades to the next as it is spoken. A
 * persistent running LIST below shows every revealed item (active row emphasized),
 * preserving the 1.2.3 count. Voice-lock, itemRevealState, caption suppression and
 * the cascade are all frozen plumbing. rendersOwnText:true suppresses the caption.
 */
function fallbackStartFrames(n: number, durationInFrames: number): number[] {
  const lead = 8;
  const usable = Math.max(1, durationInFrames - lead - 12);
  const denom = Math.max(1, n - 1);
  return Array.from({length: n}, (_, i) => lead + Math.round((usable * i) / denom));
}

const HERO_IMG = 640; // hero image box (px)
const HERO_ICON = 360; // large lucide hero (px)

const Component: React.FC<TemplateProps<EnumerationData>> = ({data, theme, timing, itemTimings}) => {
  const frame = useCurrentFrame();
  const items = data.items;
  const synced = Boolean(itemTimings && itemTimings.length === items.length);
  const starts = synced
    ? (itemTimings as NonNullable<typeof itemTimings>).map((t) => t.startFrame)
    : fallbackStartFrames(items.length, timing.durationInFrames);
  const active = activeIndex(frame, starts);
  const sz = enumerationSizing(items.length, listBandHeight()); // SAME helper the test guards

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.palette.background,
        backgroundImage: heroBackground(theme.palette, frame / HERO_BREATH_PERIOD),
      }}
    >
      {/* HERO ZONE */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: `${HERO_BAND_FRACTION * 100}%`,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '0 80px',
        }}
      >
        {items.map((label, i) => {
          const present = heroPresence(frame, i, starts);
          if (present <= 0) return null;
          const st = itemRevealState(frame, starts[i], i + 1 < starts.length ? starts[i + 1] : starts[i] + 24);
          const media = resolveMedia(label);
          const ring = `0 0 0 6px ${theme.palette.accent}55, 0 30px 80px rgba(0,0,0,0.6)`;
          return (
            <div
              key={i}
              style={{
                position: 'absolute',
                // single fade = heroPresence (already ramps over min(ENTER,gap)); st drives
                // the pop+rise only. Multiplying by st.opacity too would double-fade (sluggish).
                opacity: present,
                transform: `translateY(${st.translateY}px) scale(${st.scale})`,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 36,
              }}
            >
              {media.kind === 'image' ? (
                <Img
                  src={staticFile(media.src)}
                  alt={media.alt}
                  style={{
                    width: HERO_IMG,
                    height: HERO_IMG,
                    objectFit: 'cover',
                    borderRadius: 40,
                    boxShadow: ring,
                    background: '#000',
                  }}
                />
              ) : media.kind === 'icon' ? (
                <div style={{width: HERO_IMG, height: HERO_IMG, display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
                  <LucideGlyph name={media.name} size={HERO_ICON} color={theme.palette.foreground} />
                </div>
              ) : (
                <div style={{width: HERO_IMG, height: HERO_IMG, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.palette.muted, fontSize: HERO_ICON}}>●</div>
              )}
              <div
                style={{
                  fontFamily: `${theme.fonts.heading}, system-ui, sans-serif`,
                  fontWeight: 800,
                  fontSize: 92,
                  letterSpacing: '-0.01em',
                  color: theme.palette.accent,
                  textShadow: '0 4px 24px rgba(0,0,0,0.5)',
                }}
              >
                {label}
              </div>
            </div>
          );
        })}
      </div>

      {/* RUNNING LIST */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          width: '100%',
          height: `${(1 - HERO_BAND_FRACTION) * 100}%`,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          justifyContent: 'center',
          gap: sz.rowGap,
          padding: '0 120px',
        }}
      >
        {items.map((label, i) => {
          if (starts[i] > frame) return null; // not yet revealed
          // subtler appear (fade + small rise), NOT the hero overshoot
          const appear = Math.min(1, Math.max(0, (frame - starts[i]) / 8));
          const isActive = i === active;
          const media = resolveMedia(label);
          const iconColor = isActive ? theme.palette.accent : theme.palette.muted;
          const textColor = isActive ? theme.palette.accent : theme.palette.foreground;
          return (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: Math.round(sz.iconSize * 0.45),
                opacity: appear * (isActive ? 1 : 0.72),
                transform: `translateY(${(1 - appear) * 14}px)`,
              }}
            >
              <span style={{width: sz.iconSize, height: sz.iconSize, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0}}>
                {media.kind === 'mark' ? (
                  <span style={{fontSize: sz.iconSize * 0.6, color: iconColor}}>●</span>
                ) : (
                  // image item -> its icon (iconNameFor); icon item -> that name. The
                  // imageManifest ⊆ iconMap invariant guarantees a non-null icon here, so
                  // the `?? 'circle'` is belt-and-suspenders, never the live path.
                  <LucideGlyph
                    name={media.kind === 'icon' ? media.name : iconNameFor(label) ?? 'circle'}
                    size={Math.round(sz.iconSize * 0.82)}
                    color={iconColor}
                  />
                )}
              </span>
              <span
                style={{
                  fontFamily: `${theme.fonts.heading}, system-ui, sans-serif`,
                  fontWeight: isActive ? 800 : 700,
                  fontSize: sz.labelSize,
                  color: textColor,
                  textShadow: '0 2px 12px rgba(0,0,0,0.5)',
                }}
              >
                {label}
              </span>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

export default Component;
```

> **Note:** the list row of an image item shows its icon via the statically-imported `iconNameFor` (added to `media.ts` in Task 3) — NOT a runtime `require`. A `require()` of a local ESM module inside the Component can be left undefined in the Remotion browser bundle and break the render, so it is deliberately avoided.

- [ ] **Step 2: Typecheck**

Run: `cd remotion && npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add templates/enumeration/Component.tsx templates/enumeration/media.ts remotion/src/enumeration-media.test.ts
git commit -m "feat(tier2): image-as-hero Component — hero zone + running list

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Asset scaffold + CREDITS provenance + completeness gate

**Files:**
- Create: `templates/enumeration/assets/CREDITS.json`
- Create: `remotion/public/enumeration/` (placeholder images until the operator drops real ones)
- Create: `backend/scripts/check_enumeration_credits.py`

- [ ] **Step 1: Scaffold the CREDITS record (one entry per image-manifest key)**

Create `templates/enumeration/assets/CREDITS.json`:
```json
{
  "_note": "Per-asset provenance. The gate checks COMPLETENESS (every field filled for every bundled image), not correctness. The truth of each rights/source line is operator-owned, confirmed against NASA media-usage guidance per asset.",
  "assets": [
    {"label": "sun", "file": "enumeration/sun.jpg", "source_url": "", "rights": "", "date": ""},
    {"label": "moon", "file": "enumeration/moon.jpg", "source_url": "", "rights": "", "date": ""},
    {"label": "planet", "file": "enumeration/planets.jpg", "source_url": "", "rights": "", "date": ""},
    {"label": "eclipse", "file": "enumeration/eclipse.jpg", "source_url": "", "rights": "", "date": ""},
    {"label": "phase", "file": "enumeration/phases.jpg", "source_url": "", "rights": "", "date": ""}
  ]
}
```

- [ ] **Step 2: Write the completeness-check script**

Create `backend/scripts/check_enumeration_credits.py`:
```python
"""Gate: every bundled enumeration image has a COMPLETE provenance record.

COVERAGE direction (the part that makes "no image ships undocumented" true): we
enumerate the actual image files in remotion/public/enumeration/ and require each
to have a complete CREDITS record. An image dropped in with no record FAILS — it is
not enough to check that listed records are filled, because a no-record file would
be invisible to that. We also flag records whose file is missing (stale entry).

Checks COMPLETENESS (source_url/rights/date filled), NOT correctness — the truth of
each rights claim is operator-owned, confirmed against NASA media-usage guidance.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CREDITS = ROOT / "templates/enumeration/assets/CREDITS.json"
IMG_DIR = ROOT / "remotion/public/enumeration"
REQUIRED = ("source_url", "rights", "date")
IMG_EXTS = {".jpg", ".jpeg", ".png", ".webp"}


def main() -> int:
    data = json.loads(CREDITS.read_text())
    # index records by their on-disk path (relative to remotion/public)
    by_file = {a.get("file", ""): a for a in data.get("assets", [])}
    problems: list[str] = []

    # COVERAGE: every actual image file must have a complete record.
    actual = sorted(p for p in IMG_DIR.glob("*") if p.suffix.lower() in IMG_EXTS) if IMG_DIR.exists() else []
    for p in actual:
        rel = f"enumeration/{p.name}"
        rec = by_file.get(rel)
        if rec is None:
            problems.append(f"{rel}: image present but has NO CREDITS record (undocumented)")
            continue
        for field in REQUIRED:
            if not str(rec.get(field, "")).strip():
                problems.append(f"{rel}: empty '{field}'")

    # Hygiene: a record pointing at a missing file is stale.
    for f, rec in by_file.items():
        if not f:
            problems.append(f"{rec.get('label', '<no-label>')}: empty 'file'")
        elif not (ROOT / "remotion/public" / f).exists():
            problems.append(f"{f}: CREDITS record but image file missing")

    if not actual:
        problems.append(f"no image files in {IMG_DIR} yet — operator must drop the curated PD set")

    if problems:
        print("CREDITS gate FAILED — no image ships undocumented:")
        for p in problems:
            print(f"  - {p}")
        return 1
    print(f"CREDITS gate OK: {len(actual)} image files, all documented.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 3: Run the gate to verify it FAILS on the empty scaffold**

Run: `python backend/scripts/check_enumeration_credits.py`
Expected: exit 1 — reports no image files yet (and would report any dropped-but-unrecorded file). This proves the gate bites in the COVERAGE direction: it passes only after the operator drops the real files AND every one has a complete record.

- [ ] **Step 4: Commit the scaffold + gate**

```bash
git add templates/enumeration/assets/CREDITS.json backend/scripts/check_enumeration_credits.py
git commit -m "feat(tier2): CREDITS provenance scaffold + completeness gate (no undocumented image ships)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

> **Operator handoff:** drop the confirmed-PD, downscaled (~1280px longest edge) files into `remotion/public/enumeration/` as `sun.jpg`, `moon.jpg`, `planets.jpg`, `eclipse.jpg`, `phases.jpg`, and fill `source_url`/`rights`/`date` in `CREDITS.json`. Then `check_enumeration_credits.py` must exit 0 before the gate render.

---

## Task 9: Gate — render, regressions, eyes-on

**Files:**
- Modify: `backend/scripts/enumeration_gate.py` (add the CREDITS check + render the Tier-2 composition)

- [ ] **Step 1: Confirm the frozen regressions still pass**

Run: `cd remotion && npm run test`
Expected: all unit suites green — including the onset-sync and caption-suppress regressions (motion/look CANNOT break voice-lock).

- [ ] **Step 2: Typecheck the whole project**

Run: `cd remotion && npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Run the CREDITS completeness gate**

Run: `python backend/scripts/check_enumeration_credits.py`
Expected: exit 0 (operator has dropped real files + provenance). If exit 1, STOP — assets are not ready.

- [ ] **Step 4: Render the gate clips (real audio)**

Reuse `backend/scripts/enumeration_gate.py` for the sun/moon/planets/eclipse/phases beat and the 6-item beat (the harness already does Kokoro→whisper→enum spec→MP4 + onset table + amplitude readout). Produce `sync.mp4` and `sixitem.mp4`.

Run: `python backend/scripts/enumeration_gate.py`
Expected: two MP4s + onset table (items land at their spoken onsets, unchanged from Tier 1) + entrance amplitude readout (peak-to-trough swing per the cycle-amplitude rule).

- [ ] **Step 5: Self-read the frames, then attach the clips for the operator's ruling**

Extract a contact sheet + a dense entrance strip (own extraction, not the harness table). Confirm on pixels:
- hero crossfade completes inside each gap; exactly one hero dominant at a time (the `heroState` test guarantees this numerically — confirm it on pixels too);
- running list shows the complete count with the active row emphasized;
- 6-item list fits its band without bleeding into the hero;
- captions suppressed; images cover-cropped and coherent as a set;
- **binary active emphasis** — the list's active row snaps muted↔accent when the active index changes (unlike Tier-1's decaying accent). Confirm it doesn't read as an abrupt flip; if it does, ease it (lerp the row color over a few frames, or reuse the decaying-accent idea). Gate-tunable.
- **hero entrance feel** — opacity is now a single `heroPresence` ramp (not stacked with `st.opacity`), so it should not feel sluggish; confirm the pop+rise still reads as a punch.

Then attach `sync.mp4` + `sixitem.mp4` to chat — the build-box `cp` to uploads does NOT reach the reviewer container.

- [ ] **Step 6: Commit the gate harness changes**

```bash
git add backend/scripts/enumeration_gate.py
git commit -m "test(tier2): gate harness — Tier-2 hero render + CREDITS check + amplitude

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Finish the branch

- [ ] **Step 1: Full green sweep**

Run: `cd remotion && npm run test && npm run typecheck` and `python backend/scripts/check_enumeration_credits.py`
Expected: unit suites green, typecheck clean, CREDITS complete.

- [ ] **Step 2: Hand off for the operator's PR into `development`**

Per the branch rule, the agent does NOT merge. Summarize the gate (onset table, amplitude, attached clips, CREDITS status) and request the operator open the PR `enumeration-visual-tier2 → development`. NEVER touch master.

---

## Self-Review

**Spec coverage:**
- §2 frozen plumbing → Tasks keep voice-lock/`itemRevealState`/caption suppression untouched; Task 9 step 1 asserts the regressions. ✓
- §3 two zones + decision A (every revealed item, active emphasized) → Task 7 list renders all `starts[i] <= frame` with `isActive` emphasis. ✓
- §4 active index + bounded crossfade → Task 4 (`activeIndex`, `heroPresence`, tight-gap one-opaque test). ✓
- §5 cascade + per-zone render + icon-map invariant + list-row subtler-appear → Tasks 3 (resolver + invariant test + `iconNameFor`), 7 (per-zone render, `appear` ramp not overshoot). ✓
- §6 auto-fit re-pointed at band → Task 5 (shared `listBandHeight()` used by both test and Component). ✓
- §7 modules → Tasks 3,4,5,6,7. ✓
- §8 assets + CREDITS gate (coverage direction) + downscale → Task 8 (+ operator handoff). ✓
- §10 testing/gate → Tasks 3,4,5,6,9. ✓
- §11 sequencing → Task 0. ✓

**Review fixes folded in (from the operator's plan review):**
- **A** — no runtime `require` in the Component; `iconNameFor` is added to `media.ts` (Task 3) and statically imported (Task 7). ✓
- **B** — one `listBandHeight()` helper read by BOTH the sizing test (Task 5) and the Component (Task 7); the 58/42 split lives in a single `HERO_BAND_FRACTION` constant. ✓
- **C** — the CREDITS gate enumerates actual files in `public/enumeration/` and fails on any undocumented file (coverage), not just incomplete listed records (Task 8). ✓
- Minors: lucide-registry coverage test (Task 6); single `heroPresence` opacity ramp, no double-fade (Task 7); binary-emphasis + entrance-feel added to the gate eyes-on checklist (Task 9); CREDITS labels singular to match manifest keys (Task 8). ✓

**Placeholder scan:** No "TBD/TODO"; every code step shows full code; no `require` hack remains. ✓

**Type consistency:** `MediaResolution`/`LucideName` (Task 3) used unchanged in Tasks 6,7. `iconNameFor`/`toPascal` (Task 3) used in Tasks 6 (test + LucideGlyph) and 7. `enumerationSizing(itemCount, bandHeight)` + `listBandHeight()` + `HERO_BAND_FRACTION` (Task 5) match their uses in Task 7 and the Task 5 test. `activeIndex`/`heroPresence` (Task 4) match Task 7. ✓
