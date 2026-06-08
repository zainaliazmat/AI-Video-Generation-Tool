# Enumeration Visual Tier 1 (motion + layout) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the enumeration reveal move (overshoot entrances + a decaying active-item accent) and fill the frame (single centered auto-fit column), zero new deps, paint over the unchanged Round-3 plumbing.

**Architecture:** Two pure helpers — `reveal.ts` (evolve `itemRevealState` to add overshoot + rotate + a `[start,end)` accent that decays) and `sizing.ts` (`enumerationSizing(count)` auto-fit) — consumed by a refactored `Component.tsx`. The resolver, `itemTimings` prop, routing, caption suppression, and emoji icons are untouched; the entrance keys off the same per-item reveal starts so the voice-lock is preserved.

**Tech Stack:** TypeScript/React + Remotion (vitest), Python gate harness (Kokoro/whisper/ffmpeg).

**Reference:** design doc `docs/superpowers/specs/2026-06-08-enumeration-visual-tier1-design.md`.

**Conventions:** node PATH prefix `export PATH="$HOME/.nvm/versions/node/v22.18.0/bin:$PATH"`; vitest from `remotion/` (`npm test`); pytest from `backend/`; commit only on `enumeration-visual-tier1`.

---

## File structure

- **Modify:** `templates/enumeration/reveal.ts` (evolve `itemRevealState`), `templates/enumeration/Component.tsx` (refactor), `remotion/src/enumeration-reveal.test.ts` (extend), `backend/scripts/enumeration_gate.py` (6-item mode + amplitude readout)
- **Create:** `templates/enumeration/sizing.ts`, `remotion/src/enumeration-sizing.test.ts`
- **Untouched (must stay green):** `remotion/src/item-timing.ts`, `remotion/src/Video.tsx`, `templates/enumeration/icons.ts`, `templates/enumeration/manifest.json`, `templates/enumeration/schema.ts`, `remotion/src/item-timing.test.ts`, `remotion/src/enumeration-suppress.test.ts`, the recipe/contract.

---

## Task A: Evolve `itemRevealState` — overshoot + rotate + decaying accent

**Files:** Modify `templates/enumeration/reveal.ts`, `remotion/src/enumeration-reveal.test.ts`

- [ ] **Step 1: Rewrite the failing test** — replace `remotion/src/enumeration-reveal.test.ts` entirely

```ts
import {describe, it, expect} from 'vitest';
import {itemRevealState} from '../../templates/enumeration/reveal';

// window [start, end): end is the next item's reveal (or a fixed last-item window).
describe('itemRevealState', () => {
  it('is hidden before its reveal frame', () => {
    const s = itemRevealState(0, 30, 60);
    expect(s.opacity).toBe(0);
    expect(s.translateY).toBeGreaterThan(0);
  });
  it('overshoots scale above 1 mid-entrance, then settles to exactly 1', () => {
    const peak = itemRevealState(36, 30, 90); // ~0.6 into a 10-frame enter → past 1
    expect(peak.scale).toBeGreaterThan(1);
    const settled = itemRevealState(60, 30, 90); // well after enter
    expect(settled.scale).toBeCloseTo(1, 5);
    expect(settled.translateY).toBeCloseTo(0, 5);
    expect(settled.rotate).toBeCloseTo(0, 5);
  });
  it('opacity is monotonic up over the entrance', () => {
    const a = itemRevealState(33, 30, 90);
    const b = itemRevealState(37, 30, 90);
    expect(a.opacity).toBeGreaterThan(0);
    expect(b.opacity).toBeGreaterThan(a.opacity);
  });
  it('ACCENT DECAYS, not holds: lit early in the window, ~0 by end (next item reveals)', () => {
    const start = 30, end = 90;
    const before = itemRevealState(start - 2, start, end);
    const lit = itemRevealState(start + Math.round((end - start) * 0.4), start, end);
    const atEnd = itemRevealState(end, start, end);
    expect(before.accent).toBe(0);
    expect(lit.accent).toBeGreaterThan(0.9);
    expect(atEnd.accent).toBeLessThan(0.05); // decayed before the next item lights
  });
  it('accent stays well-formed for a NARROW window (closely spaced items)', () => {
    const s = itemRevealState(35, 33, 39); // 6-frame window
    expect(s.accent).toBeGreaterThanOrEqual(0);
    expect(s.accent).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run it (fails — signature is `(frame, startFrame)`, no accent/rotate)**

```bash
npm --prefix remotion test -- enumeration-reveal
```
Expected: FAIL (wrong arity / missing `accent`,`rotate`).

- [ ] **Step 3: Rewrite the implementation** — replace `templates/enumeration/reveal.ts` entirely

```ts
/**
 * Per-item entrance + highlight state for the enumeration reveal. Items are absent
 * until their reveal frame, then pop in with a back-ease OVERSHOOT (scale peaks > 1
 * then settles to 1) + rise + slight rotate-to-0. The just-revealed item also gets
 * a transient ACCENT over its [startFrame, endFrame) window that eases up then
 * DECAYS to 0 by endFrame (the next item's reveal) — so only the active item is
 * lit and the eye tracks the narration. Pure + remotion-free (own clamped eases) so
 * it is unit-testable and matches the gate. See hook-reveal.ts for the accent idea.
 */
export interface ItemRevealState {
  opacity: number;
  scale: number;
  translateY: number;
  rotate: number;
  accent: number; // 0..1 highlight strength, decays to 0 by endFrame
}

const ENTER = 10; // frames to fully enter

function clamp01(t: number): number {
  return Math.min(1, Math.max(0, t));
}

function easeOutCubic(t: number): number {
  const c = clamp01(t);
  return 1 - Math.pow(1 - c, 3);
}

// Back-ease overshoot: 0 at 0, peaks ~1.09 near 0.63, settles to exactly 1 at >=1.
function easeOutBack(t: number): number {
  const c = clamp01(t);
  const s = 1.70158;
  const p = c - 1;
  return 1 + (s + 1) * p * p * p + s * p * p;
}

/** Clamped piecewise-linear track; `inputs` MUST be strictly increasing. */
function track(frame: number, inputs: number[], outputs: number[]): number {
  const last = inputs.length - 1;
  if (frame <= inputs[0]) return outputs[0];
  if (frame >= inputs[last]) return outputs[last];
  for (let i = 1; i <= last; i++) {
    if (frame <= inputs[i]) {
      const r = (frame - inputs[i - 1]) / (inputs[i] - inputs[i - 1]);
      return outputs[i - 1] + r * (outputs[i] - outputs[i - 1]);
    }
  }
  return outputs[last];
}

export function itemRevealState(
  frame: number,
  startFrame: number,
  endFrame: number,
): ItemRevealState {
  const enter = easeOutCubic((frame - startFrame) / ENTER);
  const pop = easeOutBack((frame - startFrame) / ENTER);
  // Accent window as fractions of [start,end) so inputs stay strictly increasing
  // even for closely-spaced items: rise to 1 by 40%, hold to 60%, decay to 0 at end.
  const w = Math.max(1, endFrame - startFrame);
  const accent = track(
    frame,
    [startFrame, startFrame + w * 0.4, startFrame + w * 0.6, endFrame],
    [0, 1, 1, 0],
  );
  return {
    opacity: enter,
    scale: 0.8 + 0.2 * pop, // 0.8 → peak >1 → settles to 1
    translateY: (1 - enter) * 28,
    rotate: (1 - enter) * -2,
    accent: Math.max(0, accent),
  };
}
```

- [ ] **Step 4: Run it**

```bash
npm --prefix remotion test -- enumeration-reveal
```
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add templates/enumeration/reveal.ts remotion/src/enumeration-reveal.test.ts
git commit -m "feat(tier1): overshoot + rotate + decaying-accent item reveal state"
```

## Task B: `enumerationSizing` — auto-fit by item count

**Files:** Create `templates/enumeration/sizing.ts`, `remotion/src/enumeration-sizing.test.ts`

- [ ] **Step 1: Write the failing test** — `remotion/src/enumeration-sizing.test.ts`

```ts
import {describe, it, expect} from 'vitest';
import {enumerationSizing} from '../../templates/enumeration/sizing';

describe('enumerationSizing', () => {
  it('shrinks monotonically as item count grows', () => {
    const a = enumerationSizing(2), b = enumerationSizing(4), c = enumerationSizing(6);
    expect(a.iconSize).toBeGreaterThan(b.iconSize);
    expect(b.iconSize).toBeGreaterThan(c.iconSize);
    expect(a.labelSize).toBeGreaterThan(c.labelSize);
    expect(a.rowGap).toBeGreaterThanOrEqual(c.rowGap);
  });
  it('clamps below 2 and above 6', () => {
    expect(enumerationSizing(1)).toEqual(enumerationSizing(2));
    expect(enumerationSizing(9)).toEqual(enumerationSizing(6));
  });
  it('6 rows fit the 1920px frame without overflow', () => {
    const s = enumerationSizing(6);
    const rowH = Math.max(s.iconSize, s.labelSize * 1.2);
    const total = 6 * rowH + 5 * s.rowGap;
    expect(total).toBeLessThanOrEqual(1500); // generous top/bottom margin under 1920
  });
  it('fewer items are substantially larger (fills, not tiny)', () => {
    expect(enumerationSizing(2).iconSize).toBeGreaterThanOrEqual(180);
  });
});
```

- [ ] **Step 2: Run it (fails — module missing)**

```bash
npm --prefix remotion test -- enumeration-sizing
```
Expected: FAIL (cannot find module).

- [ ] **Step 3: Implement** — `templates/enumeration/sizing.ts`

```ts
/**
 * Auto-fit sizing for the enumeration column by item count: larger for fewer items
 * (so 2 fills the frame), shrinking for more so 6 fit the 1920px height WITHOUT
 * wrapping. Pure + clamped → unit-tested. Exact px are a starting point tuned on
 * the motion gate; the monotonic + no-overflow shape is the contract.
 */
export interface EnumerationSizing {
  iconSize: number;
  labelSize: number;
  rowGap: number;
}

export function enumerationSizing(itemCount: number): EnumerationSizing {
  const n = Math.max(2, Math.min(6, itemCount));
  return {
    iconSize: Math.round(200 - (n - 2) * 26), // n2:200 … n6:96
    labelSize: Math.round(104 - (n - 2) * 11), // n2:104 … n6:60
    rowGap: Math.round(112 - (n - 2) * 17), // n2:112 … n6:44
  };
}
```

- [ ] **Step 4: Run it**

```bash
npm --prefix remotion test -- enumeration-sizing
```
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add templates/enumeration/sizing.ts remotion/src/enumeration-sizing.test.ts
git commit -m "feat(tier1): enumerationSizing auto-fit by item count"
```

## Task C: Component refactor — centered auto-fit column + motion + accent

**Files:** Modify `templates/enumeration/Component.tsx`

- [ ] **Step 1: Replace the Component** — `templates/enumeration/Component.tsx`

```tsx
import React from 'react';
import {AbsoluteFill, useCurrentFrame} from 'remotion';
import type {TemplateProps} from '../sdk';
import type {EnumerationData} from './schema';
import {heroBackground, HERO_BREATH_PERIOD} from '../heroBackground';
import {iconForLabel} from './icons';
import {itemRevealState} from './reveal';
import {enumerationSizing} from './sizing';

/**
 * `enumeration` — an enumerable set revealed one-by-one IN SYNC with the narration.
 * Each item enters with a back-ease overshoot exactly as its label is spoken (or,
 * fail-closed, on an even-staggered cadence); the just-revealed item is briefly
 * accented and the accent decays as the next item reveals (only the active item
 * lit). The column is centered and auto-fits the item count to fill the frame.
 * rendersOwnText:true suppresses the global caption. (Tier 1: emoji icons stay;
 * Tier 2 swaps them for a designed set.)
 */

// Even-staggered fallback starts when there are no voice-locked timings.
function fallbackStartFrames(n: number, durationInFrames: number): number[] {
  const lead = 8;
  const usable = Math.max(1, durationInFrames - lead - 12);
  const denom = Math.max(1, n - 1);
  return Array.from({length: n}, (_, i) => lead + Math.round((usable * i) / denom));
}

const LAST_WINDOW = 24; // the last item's accent window (no "next item" to bound it)

function lerpColor(): string {
  return ''; // unused placeholder removed below
}

const Component: React.FC<TemplateProps<EnumerationData>> = ({data, theme, timing, itemTimings}) => {
  const frame = useCurrentFrame();
  const items = data.items;
  const synced = Boolean(itemTimings && itemTimings.length === items.length);
  const starts = synced
    ? (itemTimings as NonNullable<typeof itemTimings>).map((t) => t.startFrame)
    : fallbackStartFrames(items.length, timing.durationInFrames);
  // active window [start_i, end_i): end = next start, last = start + LAST_WINDOW (capped).
  const ends = starts.map((s, i) =>
    i < starts.length - 1 ? starts[i + 1] : Math.min(s + LAST_WINDOW, timing.durationInFrames),
  );
  const sz = enumerationSizing(items.length);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.palette.background,
        backgroundImage: heroBackground(theme.palette, frame / HERO_BREATH_PERIOD),
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 96px',
      }}
    >
      {/* centered block; rows left-aligned so icons line up vertically */}
      <div style={{display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: sz.rowGap}}>
        {items.map((label, i) => {
          const st = itemRevealState(frame, starts[i], ends[i]);
          // active highlight: label tints foreground → accent by st.accent, with a small pop.
          const labelColor = st.accent > 0.5 ? theme.palette.accent : theme.palette.foreground;
          const accentPop = 1 + 0.06 * st.accent;
          return (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: Math.round(sz.iconSize * 0.38),
                opacity: st.opacity,
                transform: `translateY(${st.translateY}px) rotate(${st.rotate}deg) scale(${st.scale * accentPop})`,
                transformOrigin: 'left center',
              }}
            >
              <span
                style={{
                  fontSize: sz.iconSize,
                  lineHeight: 1,
                  width: Math.round(sz.iconSize * 1.12),
                  textAlign: 'center',
                  flexShrink: 0,
                  // emoji keep their own color; this tints the mono fallback mark so it stays visible.
                  color: theme.palette.muted,
                  filter: 'drop-shadow(0 4px 18px rgba(0,0,0,0.5))',
                }}
              >
                {iconForLabel(label)}
              </span>
              <span
                style={{
                  fontFamily: `${theme.fonts.heading}, system-ui, sans-serif`,
                  fontWeight: 800,
                  fontSize: sz.labelSize,
                  letterSpacing: '-0.01em',
                  color: labelColor,
                  textShadow: '0 4px 24px rgba(0,0,0,0.5)',
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
(Delete the `lerpColor` placeholder line before saving — the tint uses a threshold on `st.accent`, no color-lerp helper needed.)

- [ ] **Step 2: Typecheck (covers Component/reveal/sizing via the import graph) + full vitest**

```bash
export PATH="$HOME/.nvm/versions/node/v22.18.0/bin:$PATH"
npm --prefix remotion run typecheck
npm --prefix remotion test
```
Expected: tsc PASS; vitest all green — including the UNCHANGED `item-timing.test.ts` and `enumeration-suppress.test.ts` (onset-sync + caption-suppress regressions hold; the entrance keys off the same starts).

- [ ] **Step 3: Backend regression (nothing backend changed, but confirm)**

```bash
backend/.venv/bin/python -m pytest -q
```
Expected: 168 passed.

- [ ] **Step 4: Commit**

```bash
git add templates/enumeration/Component.tsx
git commit -m "feat(tier1): centered auto-fit column + overshoot entrance + active-item accent"
```

## Task D: Gate harness — 6-item beat + amplitude readout

**Files:** Modify `backend/scripts/enumeration_gate.py`

- [ ] **Step 1: Add a 6-item mode + an amplitude readout (Python mirror of the entrance curve)**

Add to the modes and constants:
```python
SIXITEM_LINE = "The orrery traced the sun, the moon, the planets, an eclipse, a comet, and lunar phases."
SIXITEM_ITEMS = ["Sun", "Moon", "Planets", "Eclipse", "Comet", "Phases"]
```
Add an amplitude helper (mirrors `reveal.ts` `itemRevealState` scale curve so the readout reports the same overshoot the component renders):
```python
def _ease_out_back(t):
    c = min(1.0, max(0.0, t)); s = 1.70158; p = c - 1
    return 1 + (s + 1) * p ** 3 + s * p ** 2


def entrance_amplitude(enter=10):
    """Peak vs settle of scale = 0.8 + 0.2*easeOutBack(t) over the entrance — the
    designed overshoot the gate's amplitude column reports (eyes-on rules the feel)."""
    scales = [0.8 + 0.2 * _ease_out_back(i / enter) for i in range(0, enter + 6)]
    return {"peak": max(scales), "settle": 0.8 + 0.2 * _ease_out_back(1.0),
            "peak_at": scales.index(max(scales))}
```
Extend `main()` to accept `--mode sixitem` (items = `SIXITEM_ITEMS`, line = `SIXITEM_LINE`) and print/append the amplitude to the table:
```python
amp = entrance_amplitude()
print(f"[gate] entrance scale: settle {amp['settle']:.3f} → peak {amp['peak']:.3f} "
      f"(+{(amp['peak'] - amp['settle']):.3f} at f+{amp['peak_at']}), translateY 28→0px")
```
And add the amplitude line to `write_table`'s output (a `## Entrance amplitude` section with the peak/settle/delta).

- [ ] **Step 2: Smoke the harness arg-parsing without a render**

```bash
backend/.venv/bin/python -c "import ast; ast.parse(open('backend/scripts/enumeration_gate.py').read()); print('parse OK')"
```
Expected: `parse OK`.

- [ ] **Step 3: Commit**

```bash
git add backend/scripts/enumeration_gate.py
git commit -m "test(tier1): gate harness — 6-item beat + entrance amplitude readout"
```

## Task E: Motion gate

- [ ] **Step 1: Render sync + 6-item clips (real audio) + tables**

```bash
export PATH="$HOME/.nvm/versions/node/v22.18.0/bin:$PATH"
backend/.venv/bin/python backend/scripts/enumeration_gate.py --mode sync
backend/.venv/bin/python backend/scripts/enumeration_gate.py --mode sixitem
```
Produces `enumeration-gate-frames/{sync,sixitem}.mp4` + strips + onset tables + amplitude readouts.

- [ ] **Step 2: Self-verify on pixels (Read frames)** — confirm: items still reveal at their word onsets (onset table unchanged), the entrance has visible overshoot, the active item is accented and the accent decays, the 6-item clip fills the frame without wrapping, the final frame is settled (nothing lit).

- [ ] **Step 3: Build review strips** (montage progression frames for each clip).

- [ ] **Step 4: Surface for the reviewer** — present key frames inline + the onset/amplitude tables; **the reviewer attaches `sync.mp4` + the 6-item clip to chat** (a build-box `cp` to `/mnt/user-data/uploads` doesn't reach their container). Pause for the pixel ruling.

---

## Self-review

- **Spec coverage:** motion overshoot (Task A `easeOutBack`), accent decays-not-holds (Task A test asserts `atEnd.accent < 0.05`), rotate/translate settle (Task A), single centered auto-fit column (Task C layout + Task B sizing), 6-item no-overflow (Task B test), onset-sync + caption-suppress regressions (Task C Step 2 runs the unchanged tests), amplitude readout + 6-item clip (Task D/E), emoji untouched (Task C imports the same `iconForLabel`), transport-to-chat (Task E Step 4). Covered.
- **Placeholder scan:** the only literal placeholder is the `lerpColor` stub in Task C, explicitly deleted in the parenthetical before saving (the tint uses an `st.accent` threshold). No TBDs.
- **Type consistency:** `ItemRevealState{opacity,scale,translateY,rotate,accent}` (Task A) consumed in Task C; `itemRevealState(frame,start,end)` 3-arg signature (Task A) called in Task C; `EnumerationSizing{iconSize,labelSize,rowGap}` (Task B) consumed in Task C; `itemTimings`/`EnumerationData` unchanged from Round 3.
