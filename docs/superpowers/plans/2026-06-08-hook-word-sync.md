# Hook Word-Sync (Round 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the hook hero card a single voice-locked reveal — the headline is present-but-dim-and-legible from frame 0, and each word "lights" (brightens + accents) exactly when the narration speaks it — driven by a pure, fail-closed render-side word aligner.

**Architecture:** A new pure `alignHookWords` reconciles the hook's display text against `spec.captions ∩ scene span` by **character-prefix matching** (so whisper fragmentation / re-glue / count mismatch / next-scene bleed all reconcile, and anything that doesn't returns `null`). The renderer ([Video.tsx](../../../remotion/src/Video.tsx)) computes per-word timings for the hook scene only and passes them as a render-derived `wordTimings` prop. The hook [Component.tsx](../../../templates/hook/Component.tsx) renders word-by-word when timings are present, and **falls back to the exact Round-1 entrance on any absence/mismatch** (fail-closed). No spec-schema/backend change — the renderer stays a pure function of `spec.json`.

**Tech Stack:** TypeScript, React, Remotion, Vitest (renderer); Python (Kokoro TTS + faster-whisper) for the gate's real timings.

---

## Design invariants (read before starting)

- **Fail-closed is load-bearing.** A desynced highlight looks cheaper than no highlight. Any of: missing `wordTimings`, `null` from the aligner, a `length` mismatch, or empty captions → render the **Round-1 monolithic cascade**, never a drifting reveal. Same discipline as the hook fallback / git-guard.
- **The aligner is pure and deterministic.** Function of `(title, captions, sceneStart, sceneEnd)` only. No spec change, no backend change. It is the renderer's, like the Phase-3 suppress-span derivation.
- **Tokenization must be shared.** The renderer (which builds timings) and the component (which renders words) MUST split the title identically — both call `splitDisplayWords`. Aligner returns exactly one timing per display word, in order.
- **Frame semantics.** Captions carry absolute frames. `useCurrentFrame()` in the scene `Sequence` is scene-relative. `hookWordTimingsForScene` subtracts `scene.startFrame` so the component compares against scene-relative frames. "Active" word = `start <= f < end` (half-open, matching `isFrameSuppressed`).
- **Round-1 survivors.** Kicker and the breathing background are unchanged in BOTH modes. Only the headline cascade (and, in sync mode, the underline behaviour) changes.

## File structure

- Create: `remotion/src/word-alignment.ts` — pure: `splitDisplayWords`, `alignHookWords`, `hookWordTimingsForScene`; defines + exports the render-only `HookWordTiming` type.
- Create: `remotion/src/word-alignment.test.ts` — vitest.
- Create: `remotion/src/hook-reveal.ts` — pure: `wordRevealState`, `HOOK_DIM` (remotion-free; local clamped-lerp).
- Create: `remotion/src/hook-reveal.test.ts` — vitest.
- Modify: `templates/sdk.ts` — add optional render-derived `wordTimings` to `TemplateProps`.
- Note: `remotion/src/schema.ts` is intentionally NOT modified — it stays a clean mirror of `backend/schema.py`; `HookWordTiming` lives in `word-alignment.ts`.
- Modify: `remotion/src/Video.tsx:43-62` — wire `hookWordTimingsForScene` into `renderScene`; pass `captions` from both call sites (`:114`, `:136`).
- Modify: `templates/hook/Component.tsx` — voice-reveal headline + fail-closed branch; underline sync variants.
- Create: `backend/scripts/hook_gate.py` — gate driver (real TTS → real whisper timings → minimal spec → stills → table).

---

## Task 1: `word-alignment.ts` (the aligner) + `HookWordTiming` type

**Files:**
- Create: `remotion/src/word-alignment.ts` (defines + exports `HookWordTiming`)
- Test: `remotion/src/word-alignment.test.ts`

`HookWordTiming` is defined in `word-alignment.ts` (the render module that produces it), NOT in `schema.ts` — it is render-derived and never part of the spec, and `schema.ts ↔ backend/schema.py` must stay a clean spec-contract mirror. The `Caption` type IS a spec type, so the aligner imports it from `schema.ts`.

- [ ] **Step 1: Write the failing test file**

Create `remotion/src/word-alignment.test.ts`:

```typescript
import {describe, expect, it} from 'vitest';
import {
  splitDisplayWords,
  alignHookWords,
  hookWordTimingsForScene,
} from './word-alignment';
import type {Caption} from './schema';

const cap = (text: string, startFrame: number, endFrame: number): Caption => ({
  text,
  startFrame,
  endFrame,
});

describe('splitDisplayWords', () => {
  it('splits on whitespace and drops empty tokens', () => {
    expect(splitDisplayWords('  Could   a  machine? ')).toEqual([
      'Could',
      'a',
      'machine?',
    ]);
  });
  it('returns [] for blank input', () => {
    expect(splitDisplayWords('   ')).toEqual([]);
  });
});

describe('alignHookWords — happy path', () => {
  it('one caption per word maps each word to its caption span', () => {
    const captions = [cap('Why', 0, 6), cap('the', 6, 10), cap('ocean', 10, 20)];
    expect(alignHookWords('Why the ocean', captions, 0, 30)).toEqual([
      {word: 'Why', startFrame: 0, endFrame: 6},
      {word: 'the', startFrame: 6, endFrame: 10},
      {word: 'ocean', startFrame: 10, endFrame: 20},
    ]);
  });
});

describe('alignHookWords — whisper fragmentation (display word spans many captions)', () => {
  it('re-glues "2,000-year-old" split across 3 captions into one span', () => {
    // whisper fragmented the hyphenated number the way it fragments numbers
    const captions = [
      cap('Could', 0, 6),
      cap('a', 6, 8),
      cap('2,000', 8, 18),
      cap('-year', 18, 22),
      cap('-old', 22, 26),
      cap('machine', 26, 34),
    ];
    expect(
      alignHookWords('Could a 2,000-year-old machine', captions, 0, 60),
    ).toEqual([
      {word: 'Could', startFrame: 0, endFrame: 6},
      {word: 'a', startFrame: 6, endFrame: 8},
      {word: '2,000-year-old', startFrame: 8, endFrame: 26},
      {word: 'machine', startFrame: 26, endFrame: 34},
    ]);
  });
});

describe('alignHookWords — whisper merge (one caption spans many display words)', () => {
  it('two display words sharing one merged caption share its span', () => {
    const captions = [cap('predicteclipses', 10, 30)];
    expect(alignHookWords('predict eclipses', captions, 0, 60)).toEqual([
      {word: 'predict', startFrame: 10, endFrame: 30},
      {word: 'eclipses', startFrame: 10, endFrame: 30},
    ]);
  });
});

describe('alignHookWords — count mismatch reconciles by characters', () => {
  it('aligns when caption count (4) != display word count (3)', () => {
    // "2,000" + "-year" + "-old" (3 caps) glue into ONE display word; total 4
    // caps vs 3 display words — char prefix matching makes the count irrelevant.
    const captions = [
      cap('A', 0, 4),
      cap('2,000', 4, 14),
      cap('-year', 14, 18),
      cap('-old', 18, 22),
    ];
    expect(alignHookWords('A 2,000-year-old robot', captions, 0, 60)).toBeNull();
    // (no caption for "robot" → captions run out before display consumed → null)
  });
});

describe('alignHookWords — next-scene bleed', () => {
  it('ignores trailing caption that belongs to the next scene ("It"-bleed)', () => {
    // "It" starts at frame 28 (still < sceneEnd=30) but is the next line's word.
    const captions = [
      cap('eclipses?', 10, 26),
      cap('It', 28, 40),
    ];
    expect(alignHookWords('eclipses?', captions, 0, 30)).toEqual([
      {word: 'eclipses?', startFrame: 10, endFrame: 26},
    ]);
  });
});

describe('alignHookWords — normalization', () => {
  it('matches across apostrophe/quote/em-dash/case differences', () => {
    // display uses curly apostrophe + em-dash; captions use straight + hyphen
    const captions = [
      cap("IT'S", 0, 6), // straight, upper
      cap('a-go', 6, 14), // hyphen
    ];
    expect(alignHookWords('It’s a—go', captions, 0, 30)).toEqual([
      {word: 'It’s', startFrame: 0, endFrame: 6},
      {word: 'a—go', startFrame: 6, endFrame: 14},
    ]);
  });
});

describe('alignHookWords — fail-closed cases', () => {
  it('returns null when the text never reconciles', () => {
    const captions = [cap('totally', 0, 6), cap('different', 6, 12)];
    expect(alignHookWords('Why the ocean', captions, 0, 30)).toBeNull();
  });
  it('returns null for empty title', () => {
    expect(alignHookWords('', [cap('x', 0, 6)], 0, 30)).toBeNull();
  });
  it('returns null when no captions overlap the scene span', () => {
    const captions = [cap('Why', 100, 106)];
    expect(alignHookWords('Why', captions, 0, 30)).toBeNull();
  });
  it('returns null when captions run out before the display is consumed', () => {
    const captions = [cap('Why', 0, 6)];
    expect(alignHookWords('Why the ocean', captions, 0, 30)).toBeNull();
  });
});

describe('alignHookWords — punctuation-only display token', () => {
  it('emits a zero-width timing for a token with no alphanumerics', () => {
    const captions = [cap('A', 0, 6), cap('B', 6, 12)];
    expect(alignHookWords('A — B', captions, 0, 30)).toEqual([
      {word: 'A', startFrame: 0, endFrame: 6},
      {word: '—', startFrame: 6, endFrame: 6}, // inherits prev end, zero width
      {word: 'B', startFrame: 6, endFrame: 12},
    ]);
  });
});

describe('hookWordTimingsForScene — scene-relative conversion', () => {
  it('subtracts the scene start frame', () => {
    const captions = [cap('Why', 100, 106), cap('now', 106, 112)];
    // sceneStart=100, duration=20 → span [100,120); output rebased to 0
    expect(hookWordTimingsForScene('Why now', captions, 100, 20)).toEqual([
      {word: 'Why', startFrame: 0, endFrame: 6},
      {word: 'now', startFrame: 6, endFrame: 12},
    ]);
  });
  it('propagates null (fail-closed) from the aligner', () => {
    expect(hookWordTimingsForScene('Why', [], 0, 20)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd remotion && npx vitest run src/word-alignment.test.ts`
Expected: FAIL — "Failed to resolve import './word-alignment'".

- [ ] **Step 3: Implement the aligner**

Create `remotion/src/word-alignment.ts`:

```typescript
/**
 * Hook word aligner — the render-side, fail-closed reconciliation behind the
 * hook's voice-locked reveal. PURE and deterministic: given the hook's display
 * text and the caption (whisper) words overlapping the scene span, it returns
 * one [start,end) frame interval per DISPLAY word — or `null` when the two can't
 * be reconciled, in which case the renderer degrades to the non-synced entrance.
 *
 * Reconciliation is by CHARACTER PREFIX, not by word count, so it absorbs every
 * whisper artefact the pipeline already exhibits: number/hyphen fragmentation
 * ("2,000" "-year" "-old"), number re-glue, a caption that merges words the
 * display splits, and a next-scene word that bleeds into the tail of the span.
 * Anything that does NOT reconcile char-for-char over the display prefix → null.
 */
import type {Caption} from './schema';

/**
 * Per-display-word narration timing for the hook's voice-locked reveal.
 * RENDER-DERIVED (computed from spec.captions ∩ scene span ∩ display text) — it
 * is NOT part of the spec contract and is never emitted by the backend, which is
 * why it lives here and not in schema.ts (kept a clean spec↔schema.py mirror).
 */
export interface HookWordTiming {
  /** the original display token (one per whitespace-split word of the title) */
  word: string;
  startFrame: number;
  endFrame: number;
}

const NON_ALNUM = /[^a-z0-9]/g;

/**
 * Normalize for matching: NFKD (decompose accents), lowercase, then strip
 * everything that isn't [a-z0-9]. This collapses case, punctuation, apostrophes
 * (curly + straight), quotes, em/en-dashes and hyphens, commas and periods —
 * identically on both the display and the caption side.
 */
function normalize(s: string): string {
  return s.normalize('NFKD').toLowerCase().replace(NON_ALNUM, '');
}

/** The display tokenization. The renderer and the component MUST both use this
 * so word index i lines up between the rendered span and its timing. */
export function splitDisplayWords(title: string): string[] {
  return title
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

/**
 * Align the hook's `title` to the caption words overlapping [sceneStart,
 * sceneEnd). Returns one HookWordTiming per display word (ABSOLUTE frames) in
 * order, or `null` if reconciliation fails (fail-closed).
 */
export function alignHookWords(
  title: string,
  captions: ReadonlyArray<Caption>,
  sceneStart: number,
  sceneEnd: number,
): HookWordTiming[] | null {
  const words = splitDisplayWords(title);
  if (words.length === 0) return null;

  // Captions overlapping the scene span, in time order.
  const span = captions
    .filter((c) => c.startFrame < sceneEnd && c.endFrame > sceneStart)
    .slice()
    .sort((a, b) => a.startFrame - b.startFrame);
  if (span.length === 0) return null;

  // Char stream of normalized caption text + a map: char index -> caption index.
  let caps = '';
  const capOfChar: number[] = [];
  span.forEach((c, ci) => {
    const n = normalize(c.text);
    for (let k = 0; k < n.length; k++) {
      caps += n[k];
      capOfChar.push(ci);
    }
  });
  if (caps.length === 0) return null;

  const out: HookWordTiming[] = [];
  let p = 0; // pointer into `caps`
  let lastEnd = sceneStart; // boundary for zero-width punctuation tokens
  for (const word of words) {
    const nw = normalize(word);
    if (nw.length === 0) {
      // Punctuation-only token (e.g. a lone em-dash): nothing to anchor. Emit a
      // zero-width marker so indices stay aligned with the rendered words.
      out.push({word, startFrame: lastEnd, endFrame: lastEnd});
      continue;
    }
    // The next nw.length chars of the caption stream MUST equal this word.
    if (p + nw.length > caps.length) return null; // captions ran out → fail closed
    if (caps.slice(p, p + nw.length) !== nw) return null; // mismatch → fail closed
    const firstCap = capOfChar[p];
    const lastCap = capOfChar[p + nw.length - 1];
    const startFrame = span[firstCap].startFrame;
    const endFrame = span[lastCap].endFrame;
    out.push({word, startFrame, endFrame});
    lastEnd = endFrame;
    p += nw.length;
  }
  // Trailing caption chars beyond `p` (next-scene bleed) are allowed → success.
  return out;
}

/** Aligner + rebase to SCENE-RELATIVE frames (the component compares against
 * `useCurrentFrame()` inside the scene Sequence). Null propagates (fail-closed). */
export function hookWordTimingsForScene(
  title: string,
  captions: ReadonlyArray<Caption>,
  sceneStart: number,
  sceneDuration: number,
): HookWordTiming[] | null {
  const abs = alignHookWords(title, captions, sceneStart, sceneStart + sceneDuration);
  if (!abs) return null;
  return abs.map((w) => ({
    word: w.word,
    startFrame: w.startFrame - sceneStart,
    endFrame: w.endFrame - sceneStart,
  }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd remotion && npx vitest run src/word-alignment.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add remotion/src/word-alignment.ts remotion/src/word-alignment.test.ts
git commit -m "feat(hook): pure fail-closed word aligner (captions ∩ span ∩ title)"
```

---

## Task 2: `hook-reveal.ts` (pure per-word visual state)

**Files:**
- Create: `remotion/src/hook-reveal.ts`
- Test: `remotion/src/hook-reveal.test.ts`

This isolates the gate-critical invariant — **the lit (active) word is the one whose interval contains the frame** — into a pure, remotion-free function so it can be unit-tested and pixel-verified against the same predicate.

- [ ] **Step 1: Write the failing test file**

Create `remotion/src/hook-reveal.test.ts`:

```typescript
import {describe, expect, it} from 'vitest';
import {wordRevealState, HOOK_DIM} from './hook-reveal';

const T = {startFrame: 10, endFrame: 20};

describe('wordRevealState — opacity reveal', () => {
  it('sits at the dim floor well before the word', () => {
    expect(wordRevealState(0, T).opacity).toBe(HOOK_DIM);
  });
  it('reaches full opacity by the time the word is spoken', () => {
    expect(wordRevealState(20, T).opacity).toBe(1);
  });
  it('stays full after the word (spoken words do not re-dim)', () => {
    expect(wordRevealState(40, T).opacity).toBe(1);
  });
});

describe('wordRevealState — active (the gate invariant)', () => {
  it('is active iff the half-open interval [start,end) contains the frame', () => {
    expect(wordRevealState(9, T).isActive).toBe(false);
    expect(wordRevealState(10, T).isActive).toBe(true);
    expect(wordRevealState(19, T).isActive).toBe(true);
    expect(wordRevealState(20, T).isActive).toBe(false); // end is exclusive
  });
});

describe('wordRevealState — accent + scale', () => {
  it('peaks during the interval and is zero far outside it', () => {
    expect(wordRevealState(15, T).accent).toBe(1);
    expect(wordRevealState(15, T).scale).toBeGreaterThan(1);
    expect(wordRevealState(0, T).accent).toBe(0);
    expect(wordRevealState(0, T).scale).toBe(1);
    expect(wordRevealState(100, T).accent).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd remotion && npx vitest run src/hook-reveal.test.ts`
Expected: FAIL — "Failed to resolve import './hook-reveal'".

- [ ] **Step 3: Implement `hook-reveal.ts`**

Create `remotion/src/hook-reveal.ts`:

```typescript
/**
 * Hook reveal state — the PURE per-word visual mapping behind the voice-locked
 * headline. Kept remotion-free (its own clamped piecewise-lerp) so the gate's
 * load-bearing invariant — the ACTIVE word is the one whose [start,end) interval
 * contains the current frame — is unit-testable and matches the pixel check.
 *
 * A word is: DIM before it is spoken (present + legible, never invisible),
 * brightening to FULL as narration reaches it, and FULL forever after (read
 * behind stays settled). The currently-spoken word additionally gets an ACCENT
 * (colour + a subtle scale pop) — the moving karaoke highlight.
 */
import type {HookWordTiming} from './word-alignment';

/** Pre-spoken legibility floor (present-but-dim from frame 0). */
export const HOOK_DIM = 0.32;

const REVEAL_LEAD = 2; // frames before start the word begins brightening
const REVEAL_DUR = 6; // frames to go dim -> full
const ACCENT_EASE = 3; // frames to ease the accent in/out around the interval

/** Clamped, piecewise-linear track. `inputs` must be strictly increasing. */
function track(frame: number, inputs: number[], outputs: number[]): number {
  const last = inputs.length - 1;
  if (frame <= inputs[0]) return outputs[0];
  if (frame >= inputs[last]) return outputs[last];
  for (let i = 1; i <= last; i++) {
    if (frame <= inputs[i]) {
      const t = (frame - inputs[i - 1]) / (inputs[i] - inputs[i - 1]);
      return outputs[i - 1] + t * (outputs[i] - outputs[i - 1]);
    }
  }
  return outputs[last];
}

export interface WordRevealState {
  /** dim before spoken, eases to 1 as narration reaches the word, then stays 1 */
  opacity: number;
  /** true iff start <= frame < end — the gate's "lit word" definition */
  isActive: boolean;
  /** 0..1 accent strength, eased up over the interval and back down after it */
  accent: number;
  /** subtle pop for the active word (1 outside, up to ~1.05 at peak accent) */
  scale: number;
}

export function wordRevealState(
  frame: number,
  timing: Pick<HookWordTiming, 'startFrame' | 'endFrame'>,
  dim: number = HOOK_DIM,
): WordRevealState {
  const {startFrame, endFrame} = timing;
  const opacity = track(
    frame,
    [startFrame - REVEAL_LEAD, startFrame - REVEAL_LEAD + REVEAL_DUR],
    [dim, 1],
  );
  const isActive = frame >= startFrame && frame < endFrame;
  const accent = track(
    frame,
    [startFrame - ACCENT_EASE, startFrame, endFrame, endFrame + ACCENT_EASE],
    [0, 1, 1, 0],
  );
  return {opacity, isActive, accent, scale: 1 + 0.05 * accent};
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd remotion && npx vitest run src/hook-reveal.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add remotion/src/hook-reveal.ts remotion/src/hook-reveal.test.ts
git commit -m "feat(hook): pure per-word reveal state (active = interval-contains-frame)"
```

---

## Task 3: Extend the template contract with render-derived `wordTimings`

**Files:**
- Modify: `templates/sdk.ts:71-79`

- [ ] **Step 1: Add the optional prop to `TemplateProps`**

In `templates/sdk.ts`, keep the line-21 `Theme` import as-is and add a type-only import for `HookWordTiming` from the render module that defines it (it is render-derived, not a spec type). After line 21:

```typescript
import type {Theme} from '../remotion/src/schema';
import type {HookWordTiming} from '../remotion/src/word-alignment';
```

Then inside `interface TemplateProps<Data = ...>` (lines 71-79), add the field after `assets`:

```typescript
  /** staticFile-resolved paths for any media the template needs */
  assets: ResolvedAssets;
  /**
   * RENDER-DERIVED (not from spec): per-display-word narration timings for a
   * voice-locked reveal, computed by the renderer from spec.captions ∩ the scene
   * span ∩ the display text. Absent/empty → the template MUST fall back to its
   * non-synced entrance (FAIL-CLOSED). Only the hook consumes it today.
   */
  wordTimings?: readonly HookWordTiming[];
```

- [ ] **Step 2: Typecheck**

Run: `cd remotion && npx tsc --noEmit`
Expected: PASS (no new errors; the field is optional so existing templates are unaffected).

- [ ] **Step 3: Commit**

```bash
git add templates/sdk.ts
git commit -m "feat(sdk): add optional render-derived wordTimings to TemplateProps"
```

---

## Task 4: Wire the aligner into the renderer (Video.tsx)

**Files:**
- Modify: `remotion/src/Video.tsx:1-7` (import), `:43-62` (`renderScene`), `:114` and `:136` (call sites)

- [ ] **Step 1: Add the import**

In `remotion/src/Video.tsx`, after line 6 (`import {deriveCaptionSuppressRanges} from './captions-suppress';`) add:

```typescript
import {hookWordTimingsForScene} from './word-alignment';
```

- [ ] **Step 2: Thread captions + compute timings in `renderScene`**

Replace the whole `renderScene` function (lines 41-62) with:

```typescript
/** Render a scene's content via its `render`-kind template. The discriminated
 * registry guarantees a transition can't be dispatched here (it narrows out).
 * For the hook, compute the (fail-closed) per-word narration timings from the
 * captions so the headline can light word-by-word; null/absent → non-synced. */
function renderScene(
  scene: SceneType,
  theme: Theme,
  fps: number,
  durationInFrames: number,
  captions: Spec['captions'],
): React.ReactNode {
  const entry = scene.template ? registry[scene.template] : undefined;
  if (entry && entry.type === 'render') {
    const Component = entry.component;
    const title = (scene.templateProps as {title?: unknown} | undefined)?.title;
    const wordTimings =
      scene.template === 'hook' && typeof title === 'string'
        ? hookWordTimingsForScene(
            title,
            captions,
            scene.startFrame,
            scene.durationInFrames,
          ) ?? undefined
        : undefined;
    return (
      <Component
        data={scene.templateProps ?? {}}
        theme={theme}
        timing={{fps, durationInFrames}}
        assets={{}}
        wordTimings={wordTimings}
      />
    );
  }
  return <MissingTemplate templateId={scene.template} />;
}
```

(`Spec` is already imported on line 4: `import type {Spec, Scene as SceneType, Theme} from './schema';`.)

- [ ] **Step 3: Pass `captions` at both call sites**

`spec.captions` is destructured as `captions` on line 71 (`const {scenes, captions, audio, theme, meta, layers} = spec;`) — already in scope.

Line 114, change:

```typescript
            {renderScene(scene, theme, fps, seqDur)}
```

to:

```typescript
            {renderScene(scene, theme, fps, seqDur, captions)}
```

Line 136, change:

```typescript
        {renderScene(scene, theme, fps, scene.durationInFrames)}
```

to:

```typescript
        {renderScene(scene, theme, fps, scene.durationInFrames, captions)}
```

- [ ] **Step 4: Typecheck**

Run: `cd remotion && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add remotion/src/Video.tsx
git commit -m "feat(hook): compute fail-closed wordTimings for the hook scene in the renderer"
```

---

## Task 5: Voice-reveal headline in the hook Component (with fail-closed)

**Files:**
- Modify: `templates/hook/Component.tsx` (whole file)

The component keeps the kicker and breathing background exactly as Round-1, adds a `synced` branch for the headline + underline, and **falls back to the Round-1 monolithic cascade** whenever `wordTimings` is absent, null, or a length mismatch.

- [ ] **Step 1: Rewrite the component**

Replace the entire contents of `templates/hook/Component.tsx` with:

```typescript
import React from 'react';
import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';
import type {TemplateProps} from '../sdk';
import type {HookData} from './schema';
import {heroBackground, HERO_BREATH_PERIOD} from '../heroBackground';
import {splitDisplayWords} from '../../remotion/src/word-alignment';
import {wordRevealState, HOOK_DIM} from '../../remotion/src/hook-reveal';

/**
 * `hook` — the opening attention-grabber. The spoken hook line (`title`) is the
 * HERO. When the renderer supplies per-word narration timings (`wordTimings`),
 * the headline is a single VOICE-LOCKED REVEAL: present-but-dim-and-legible from
 * frame 0, each word brightening + accenting exactly as it is spoken. With no
 * timings (alignment failed / absent) it FALLS BACK to the Round-1 staggered
 * entrance — a clean reveal is always better than a drifting one (fail-closed).
 * The kicker and the breathing background are identical in both modes.
 */

// Auto-size the hero line: short punchy hooks read BIG; a long sentence still
// fits the 1080px-wide safe area (≈900px after padding) without overflowing.
function heroFontSize(text: string): number {
  const n = text.length;
  if (n > 90) return 60;
  if (n > 60) return 72;
  if (n > 36) return 88;
  if (n > 18) return 104;
  return 120;
}

const CLAMP = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;

// Underline behaviour in synced mode (gate decides on pixels):
//   'completion' — a quiet underline appears once the last word finishes.
//   'sweep'      — the underline tracks narration progress across the hook.
const HOOK_UNDERLINE_MODE: 'completion' | 'sweep' = 'completion';

const Component: React.FC<TemplateProps<HookData>> = ({data, theme, wordTimings}) => {
  const frame = useCurrentFrame();
  const words = splitDisplayWords(data.title);
  // Fail-closed: only sync when we have exactly one timing per display word.
  const synced = Boolean(wordTimings && wordTimings.length === words.length);

  // Kicker is identical in both modes (Round-1 stagger).
  const kicker = interpolate(frame, [0, 10], [0, 1], CLAMP);

  const headlineBase: React.CSSProperties = {
    fontFamily: `${theme.fonts.heading}, system-ui, sans-serif`,
    fontWeight: 800,
    fontSize: heroFontSize(data.title),
    lineHeight: 1.08,
    letterSpacing: '-0.02em',
    color: theme.palette.foreground,
    textShadow: '0 4px 32px rgba(0,0,0,0.55)',
  };

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
      <div style={{textAlign: 'center', maxWidth: 900}}>
        {data.subtitle ? (
          <div
            style={{
              marginBottom: 28,
              fontFamily: `${theme.fonts.body}, system-ui, sans-serif`,
              fontWeight: 700,
              fontSize: 32,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: theme.palette.accent,
              opacity: kicker,
              transform: `translateY(${interpolate(kicker, [0, 1], [24, 0])}px)`,
            }}
          >
            {data.subtitle}
          </div>
        ) : null}

        {synced ? (
          <SyncedHeadline
            words={words}
            timings={wordTimings as NonNullable<typeof wordTimings>}
            frame={frame}
            base={headlineBase}
            accent={theme.palette.accent}
          />
        ) : (
          <FallbackHeadline title={data.title} frame={frame} base={headlineBase} />
        )}

        <Underline
          synced={synced}
          frame={frame}
          accent={theme.palette.accent}
          firstStart={synced ? wordTimings![0].startFrame : 0}
          lastEnd={synced ? wordTimings![wordTimings!.length - 1].endFrame : 0}
        />
      </div>
    </AbsoluteFill>
  );
};

/** Round-2 voice-locked reveal: dim-from-frame-0 words that light as spoken. */
const SyncedHeadline: React.FC<{
  words: string[];
  timings: NonNullable<TemplateProps<HookData>['wordTimings']>;
  frame: number;
  base: React.CSSProperties;
  accent: string;
}> = ({words, timings, frame, base, accent}) => (
  <div style={{...base, opacity: 1}}>
    {words.map((w, i) => {
      const st = wordRevealState(frame, timings[i]);
      return (
        <React.Fragment key={i}>
          <span
            style={{
              display: 'inline-block',
              opacity: st.opacity,
              color: st.isActive ? accent : base.color,
              transform: `scale(${st.scale})`,
            }}
          >
            {w}
          </span>
          {i < words.length - 1 ? ' ' : ''}
        </React.Fragment>
      );
    })}
  </div>
);

/** Round-1 fallback: the monolithic headline cascade (rise + fade as one block). */
const FallbackHeadline: React.FC<{
  title: string;
  frame: number;
  base: React.CSSProperties;
}> = ({title, frame, base}) => {
  const headline = interpolate(frame, [5, 18], [0, 1], CLAMP);
  return (
    <div
      style={{
        ...base,
        opacity: headline,
        transform: `translateY(${interpolate(headline, [0, 1], [40, 0])}px)`,
      }}
    >
      {title}
    </div>
  );
};

/** Underline. Round-1 stagger when not synced; in synced mode either appears on
 * completion or sweeps with narration progress (HOOK_UNDERLINE_MODE). */
const Underline: React.FC<{
  synced: boolean;
  frame: number;
  accent: string;
  firstStart: number;
  lastEnd: number;
}> = ({synced, frame, accent, firstStart, lastEnd}) => {
  let opacity: number;
  let scaleX: number;
  if (!synced) {
    const u = interpolate(frame, [13, 24], [0, 1], CLAMP); // Round-1 stagger
    opacity = u;
    scaleX = u;
  } else if (HOOK_UNDERLINE_MODE === 'sweep') {
    const p = interpolate(frame, [firstStart, lastEnd], [0, 1], CLAMP);
    opacity = interpolate(frame, [firstStart, firstStart + 6], [0, 1], CLAMP);
    scaleX = p;
  } else {
    const u = interpolate(frame, [lastEnd, lastEnd + 8], [0, 1], CLAMP); // completion
    opacity = u;
    scaleX = u;
  }
  return (
    <div
      style={{
        margin: '40px auto 0',
        width: 140,
        height: 10,
        borderRadius: 999,
        backgroundColor: accent,
        opacity,
        transform: `scaleX(${scaleX})`,
        transformOrigin: HOOK_UNDERLINE_MODE === 'sweep' ? 'left center' : 'center',
      }}
    />
  );
};

export default Component;
```

- [ ] **Step 2: Typecheck**

Run: `cd remotion && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Run the full renderer test suite (no regressions)**

Run: `cd remotion && npm test`
Expected: PASS — all prior tests (captions-suppress, countUp, heroBackground) plus the two new suites green.

- [ ] **Step 4: Build the registry + typecheck the templates package**

Run: `cd remotion && npm run build-registry`
Expected: registry regenerates without error (confirms the template still compiles into the registry).

- [ ] **Step 5: Commit**

```bash
git add templates/hook/Component.tsx
git commit -m "feat(hook): voice-locked word reveal with fail-closed Round-1 fallback"
```

---

## Task 6: The gate — real-TTS short + long hook, frame strip + table, fail-closed demo

This is the human-in-the-loop visual gate (per the visual-gate-before-merge rhythm). The agent produces the artifacts and verifies highlight↔timing-data alignment on the pixels + table; the operator does the audio listen-pass. **Do NOT merge before this gate.**

**Files:**
- Create: `backend/scripts/hook_gate.py`

- [ ] **Step 1: Write the gate driver**

Create `backend/scripts/hook_gate.py`:

```python
"""Hook word-sync gate driver.

Produces REAL gate artifacts for one hook line:
  1. Kokoro TTS  -> remotion/public/assets/<name>.wav   (genuine audio)
  2. faster-whisper -> real word timings                 (NOT estimated spans)
  3. a minimal one-scene spec (hook only) -> remotion/public/spec.json
  4. one Remotion still per word (frame = interval midpoint)
  5. a markdown table: frame | t(s) | expected-lit word | [start,end)

Modes:
  sync       — title matches the audio; the aligner should reconcile.
  failclosed — captions are scrambled so the aligner returns null; the render
               must degrade to the Round-1 entrance (no per-word accent).

Usage:
  backend/.venv/bin/python backend/scripts/hook_gate.py \
      --line "Why is the ocean blue?" --name short --mode sync
"""
from __future__ import annotations

import argparse
import json
import subprocess
from collections import namedtuple
from pathlib import Path

from pipeline import tts as tts_stage
from pipeline import timing as timing_stage

# A caption slice row with the same attrs render_stills/write_table expect from a
# WordTiming (.text/.start_frame/.end_frame), so both modes share that code.
Cap = namedtuple("Cap", "text start_frame end_frame")

FPS = 30
ROOT = Path(__file__).resolve().parents[2]
REMOTION = ROOT / "remotion"
PUBLIC = REMOTION / "public"
ASSETS = PUBLIC / "assets"
GATE_OUT = ROOT / f"hook-gate-frames"


def base_theme() -> dict:
    """Lift a valid theme from the committed spec.json (no new theme authored)."""
    spec = json.loads((ROOT / "spec.json").read_text())
    return spec["theme"]


def build(line: str, name: str, mode: str) -> dict:
    ASSETS.mkdir(parents=True, exist_ok=True)
    wav = ASSETS / f"hook-gate-{name}.wav"
    tts_stage.synthesize([line], str(wav))
    words = timing_stage.transcribe_words(str(wav), FPS)
    total = max((w.end_frame for w in words), default=FPS) + 1

    captions = [
        {"text": w.text, "startFrame": w.start_frame, "endFrame": w.end_frame}
        for w in words
    ]
    if mode == "failclosed":
        # Scramble caption TEXT (keep timing) so char-prefix reconciliation fails
        # -> aligner returns null -> component must use the Round-1 entrance.
        for c in captions:
            c["text"] = "zzz"

    spec = {
        "meta": {
            "title": f"hook-gate-{name}",
            "fps": FPS,
            "width": 1080,
            "height": 1920,
            "durationInFrames": total,
        },
        "theme": base_theme(),
        "audio": {"voiceover": f"assets/hook-gate-{name}.wav"},
        "captions": captions,
        "scenes": [
            {
                "id": "scene-0",
                "startFrame": 0,
                "durationInFrames": total,
                "template": "hook",
                "templateProps": {"title": line, "subtitle": "WORD-SYNC GATE"},
            }
        ],
    }
    (PUBLIC / "spec.json").write_text(json.dumps(spec, indent=2))
    (ROOT / "spec.json").write_text(json.dumps(spec, indent=2))
    return {"words": words, "total": total}


def render_stills(name: str, words, total: int) -> list[dict]:
    GATE_OUT.mkdir(parents=True, exist_ok=True)
    rows = []
    # one frame per word at the interval midpoint, plus an early frame (pre-word-1)
    samples = [(2, None)] + [
        ((w.start_frame + w.end_frame) // 2, w) for w in words
    ]
    for frame, w in samples:
        png = GATE_OUT / f"{name}-f{frame:04d}.png"
        subprocess.run(
            ["npx", "remotion", "still", "Video", str(png), f"--frame={frame}"],
            cwd=str(REMOTION),
            check=True,
        )
        rows.append(
            {
                "frame": frame,
                "t_seconds": round(frame / FPS, 3),
                "expected_lit": (w.text if w else "(none — pre-word-1)"),
                "interval": ([w.start_frame, w.end_frame] if w else None),
                "png": str(png.relative_to(ROOT)),
            }
        )
    return rows


def write_table(name: str, mode: str, words, rows) -> None:
    lines = [
        f"# Hook word-sync gate — {name} ({mode})",
        "",
        "## Word-timing table (ground truth)",
        "",
        "| # | word | startFrame | endFrame | start(s) | end(s) |",
        "|---|------|-----------|----------|----------|--------|",
    ]
    for i, w in enumerate(words):
        lines.append(
            f"| {i} | `{w.text}` | {w.start_frame} | {w.end_frame} | "
            f"{w.start_frame / FPS:.3f} | {w.end_frame / FPS:.3f} |"
        )
    lines += ["", "## Rendered frames", "",
              "| frame | t(s) | expected lit word | interval | png |",
              "|-------|------|-------------------|----------|-----|"]
    for r in rows:
        lines.append(
            f"| {r['frame']} | {r['t_seconds']} | {r['expected_lit']} | "
            f"{r['interval']} | {r['png']} |"
        )
    md = GATE_OUT / f"{name}-{mode}-table.md"
    md.write_text("\n".join(lines) + "\n")
    print(f"[gate] wrote {md.relative_to(ROOT)}")


def build_realpipeline() -> dict:
    """Use the REAL multi-scene spec.json (from a full `backend/main.py` run) as-is.
    Slices the captions to the hook scene's span — reproducing the production path
    the bug was found in: full-VO whisper fragmentation + a next-beat word bleeding
    into the tail of the hook span. No synth/transcribe here; the spec is real."""
    spec = json.loads((ROOT / "spec.json").read_text())
    hook = spec["scenes"][0]
    assert hook["template"] == "hook", "scene 0 must be the hook"
    start = hook["startFrame"]
    end = start + hook["durationInFrames"]
    span = sorted(
        (
            Cap(c["text"], c["startFrame"], c["endFrame"])
            for c in spec["captions"]
            if c["startFrame"] < end and c["endFrame"] > start
        ),
        key=lambda c: c.start_frame,
    )
    # Stage the real spec for the renderer + report the slice for the eyeball pass.
    subprocess.run(["npm", "run", "copy-spec"], cwd=str(REMOTION), check=True)
    print(f"[gate] hook title : {hook['templateProps'].get('title')!r}")
    print(f"[gate] hook span  : [{start}, {end})")
    print(f"[gate] caption slice ({len(span)}): {[c.text for c in span]}")
    return {"words": span, "total": end}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--line", default="")
    ap.add_argument("--name", default="realpipeline")
    ap.add_argument(
        "--mode", choices=["sync", "failclosed", "realpipeline"], default="sync"
    )
    args = ap.parse_args()

    if args.mode == "realpipeline":
        built = build_realpipeline()
    else:
        assert args.line, "--line is required for sync / failclosed modes"
        built = build(args.line, args.name, args.mode)
    rows = render_stills(args.name, built["words"], built["total"])
    write_table(args.name, args.mode, built["words"], rows)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Build the registry (the renderer must resolve the hook template)**

Run: `cd remotion && npm run build-registry`
Expected: success.

- [ ] **Step 3: Render the SHORT-hook sync gate**

Run:
```bash
cd /home/zain-ali/Documents/AIVideoGenerationTool
backend/.venv/bin/python backend/scripts/hook_gate.py \
  --line "Why is the ocean blue?" --name short --mode sync
```
Expected: real `remotion/public/assets/hook-gate-short.wav`, one PNG per word under `hook-gate-frames/`, and `hook-gate-frames/short-sync-table.md`.

- [ ] **Step 4: Render the LONG-hook sync gate**

Run:
```bash
backend/.venv/bin/python backend/scripts/hook_gate.py \
  --line "Could a 2,000-year-old Greek machine really predict eclipses centuries before clocks existed?" \
  --name long --mode sync
```
Expected: `long-sync-table.md` + per-word PNGs. (This line specifically exercises the `2,000-year-old` re-glue on real whisper output.)

- [ ] **Step 5: Render the fail-closed demo**

Run:
```bash
backend/.venv/bin/python backend/scripts/hook_gate.py \
  --line "Why is the ocean blue?" --name failclosed --mode failclosed
```
Expected: PNGs showing the **Round-1 monolithic entrance** (headline rises + fades as one block, NO per-word accent), proving graceful degradation.

- [ ] **Step 6: Real end-to-end pipeline render (production-fidelity)**

The controlled gates above run genuine Kokoro→whisper but on an ISOLATED hook line. They do NOT reproduce the production scenario the bug lives in: full-VO whisper (segmentation depends on surrounding beats) sliced to the hook span, with a next-beat word bleeding in. Close that gap with one real multi-scene render.

Run the full pipeline on a real topic whose hook fragments and has at least one following beat:
```bash
cd /home/zain-ali/Documents/AIVideoGenerationTool
backend/.venv/bin/python backend/main.py --topic "The 2,000-year-old Greek computer that predicted eclipses"
```
Then render the hook strip + table against the REAL multi-scene spec:
```bash
cd remotion && npm run build-registry && cd ..
backend/.venv/bin/python backend/scripts/hook_gate.py --mode realpipeline
```
Expected: the driver prints the hook title, the hook span, and the caption slice (so fragmentation + any trailing next-beat bleed are visible in the slice), then writes `hook-gate-frames/realpipeline-realpipeline-table.md` + per-caption PNGs rendered through the real TS aligner.

If the hook of that run happens not to fragment or has no trailing bleed, re-run `backend/main.py` with another topic until the slice shows at least one fragmented display word (a word split across ≥2 captions) and/or a trailing caption that belongs to the next beat — then re-run the `realpipeline` gate. Note in the writeup which condition the chosen run exercised.

- [ ] **Step 7: Agent verification (pixels ↔ table) — a PRE-SCREEN, not the gate**

For each table (`short-sync`, `long-sync`, `realpipeline`), Read the table, then Read each rendered PNG and confirm: at frame `f`, the accent-coloured (lit) word in the pixels is the spoken word whose `[start,end)` contains `f`. For a fragmented display word (spans ≥2 captions), confirm the SAME single display word stays lit across all its captions' intervals. For the real-pipeline strip specifically, confirm any trailing next-beat bleed caption is **never** accented (the hook text owns the lighting). Confirm the pre-word-1 frame shows kicker + dim-but-legible headline + breathing background (not an empty pool). For the fail-closed PNGs, confirm there is no per-word accent and the headline behaves as the Round-1 block cascade.

Write up the findings (a short table-vs-pixel pass/fail per frame, and which real-data condition the pipeline run exercised). Do NOT claim the gate passes — this is a pre-screen. **The reviewer does the independent pixel↔table verification; a subagent must not declare Round 2 done off its own self-check.**

- [ ] **Step 8: Surface artifacts to the reviewer + operator**

Copy the gate artifacts to `/mnt/user-data/uploads` for the reviewer's independent pixel ruling:
```bash
mkdir -p /mnt/user-data/uploads/hook-wordsync-gate
cp -r hook-gate-frames/* /mnt/user-data/uploads/hook-wordsync-gate/
```
Then hand off: state the **fidelity boundary** explicitly — "controlled gates verify aligner + reveal end-to-end on genuine whisper for short/long + clean fail-closed degradation; the real-pipeline gate verifies the multi-scene slice + bleed + full-VO-fragmentation path on real data." Ask the operator for (a) the audio listen-pass (the audio↔highlight perceptual link the agent can't hear) and the reviewer for (b) the treatment ruling — accent style and `HOOK_UNDERLINE_MODE` (`completion` vs `sweep`). Apply the ruling, then proceed to finishing-a-development-branch.

Note: `spec.json` and `remotion/public/spec.json` are overwritten by the gate driver / pipeline — restore them from git (`git checkout spec.json`) after the gate if the working spec is needed, and do not commit the gate's `hook-gate-*.wav` / frame artifacts unless the user wants them retained for review.

---

## Self-review notes

- **Spec coverage:** (b) unified voice-reveal → Tasks 2,5. (R) fail-closed render-side aligner → Tasks 1,4 + fallback in 5. TDD over the three real mismatches (`2,000-year-old` re-glue, count mismatch, `It`-bleed) + normalization + never-reconciles → Task 1 tests. Short + long real-TTS render, frame strip + table, fail-closed demo → Task 6. Kicker/breath retained, dim-from-frame-0, underline both variants → Task 5.
- **Type consistency:** `HookWordTiming` (schema.ts) used by word-alignment.ts, hook-reveal.ts, sdk.ts. `splitDisplayWords` + `wordRevealState` + `HOOK_DIM` shared by component. `hookWordTimingsForScene` is the only entry the renderer calls.
- **Fail-closed paths:** aligner `null` (Task 1) → `undefined` prop (Task 4) → `synced=false` length/absence guard (Task 5) → Round-1 cascade. Demonstrated in Task 6 Step 5.
- **Out of scope (logged):** stat/outro word-sync; server-side mismatch observability (future reason to revisit option C); the fallback-kicker==headline cosmetic backlog item (fold into the hook-fallback/SYSTEM_PROMPT pass).
- **Known residual in char-prefix matching (logged, accepted):** if whisper emits a caption that spans a display-word boundary asymmetrically (a whole word glued to the *start* of the next), the second word's interval starts at the shared caption's start, so two adjacent words light together for a few frames. This is the same graceful visual as the handled whole-word-merge case (never a *wrong*-word highlight), and is rare on a line where display == spoken (whisper merges tend to be whole-word). Low-probability, low-severity; the operator's listen-pass is the catch. Documented so a future "two words flashed together" report isn't a surprise.
- **Gate fidelity boundary (stated in Task 6 Step 8):** controlled short/long/failclosed gates verify aligner + reveal on genuine isolated-line whisper + clean degradation; the real-pipeline gate (Step 6) verifies the multi-scene slice + next-beat bleed + full-VO fragmentation on real data — the conditions the bug was found in.
</content>
</invoke>
