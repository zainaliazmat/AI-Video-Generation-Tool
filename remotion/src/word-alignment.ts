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
    // sort by start frame; whisper never emits equal startFrames, and Array.sort
    // is stable, so any (theoretical) tie keeps input order.
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
  // Boundary for zero-width punctuation tokens. A leading punctuation-only
  // token has no prior word, so it anchors at sceneStart (harmless: punctuation
  // never receives the active accent).
  let lastEnd = sceneStart;
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
