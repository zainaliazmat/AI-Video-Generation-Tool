/**
 * Item-timing resolver — the render-side, fail-closed reconciliation behind the
 * enumeration layout's voice-locked one-by-one reveal. PURE and deterministic:
 * given the item labels and the per-word captions overlapping the scene span, it
 * returns one reveal frame per item (scene-relative) — or `null` when the labels
 * can't be resolved in order (set-level fail-closed, design §2.2), in which case
 * the component degrades to an even-staggered entrance.
 *
 * Unlike the hook's `alignHookWords` (which marches a single contiguous-prefix
 * pointer because the display line IS the verbatim narration), item labels are
 * scattered tokens inside a richer sentence, so this is an IN-ORDER SUBSEQUENCE
 * search: each label (in order) is found at-or-after a monotonically advancing
 * pointer. Tolerance is exact-normalized first, then a bounded prefix/plural match
 * gated by a ≥4-char minimum on BOTH sides (so "sun" never grabs "sunday").
 */
import type {Caption} from './schema';

export interface ItemTiming {
  index: number;
  label: string;
  startFrame: number; // SCENE-RELATIVE
}

const NON_ALNUM = /[^a-z0-9]/g;
function normalize(s: string): string {
  return s.normalize('NFKD').toLowerCase().replace(NON_ALNUM, '');
}

const MIN_PREFIX = 4;
/** exact normalized equality, else bounded prefix (plural/stem) when BOTH ≥4 chars. */
function tokenMatch(labelTok: string, capTok: string): boolean {
  if (!labelTok || !capTok) return false;
  if (labelTok === capTok) return true;
  if (labelTok.length >= MIN_PREFIX && capTok.length >= MIN_PREFIX) {
    return capTok.startsWith(labelTok) || labelTok.startsWith(capTok);
  }
  return false;
}

/** First index ≥ `from` where `toks` match consecutive caption words; -1 if none. */
function findSequence(
  caps: ReadonlyArray<{norm: string; startFrame: number}>,
  from: number,
  toks: readonly string[],
): number {
  for (let k = from; k + toks.length <= caps.length; k++) {
    let ok = true;
    for (let t = 0; t < toks.length; t++) {
      if (!tokenMatch(toks[t], caps[k + t].norm)) {
        ok = false;
        break;
      }
    }
    if (ok) return k;
  }
  return -1;
}

export function itemTimingsForScene(
  labels: readonly string[],
  captions: ReadonlyArray<Caption>,
  sceneStart: number,
  sceneDuration: number,
): ItemTiming[] | null {
  if (labels.length === 0) return null;
  const sceneEnd = sceneStart + sceneDuration;
  const caps = captions
    .filter((c) => c.startFrame < sceneEnd && c.endFrame > sceneStart)
    .slice()
    .sort((a, b) => a.startFrame - b.startFrame)
    .map((c) => ({norm: normalize(c.text), startFrame: c.startFrame}));
  if (caps.length === 0) return null;

  const out: ItemTiming[] = [];
  let ci = 0; // monotonic pointer → enforces in-order resolution
  for (let li = 0; li < labels.length; li++) {
    const toks = labels[li]
      .trim()
      .split(/\s+/)
      .map(normalize)
      .filter((t) => t.length > 0);
    if (toks.length === 0) return null; // a label with no alnum content → fail closed
    const at = findSequence(caps, ci, toks);
    if (at < 0) return null; // missing or out-of-order → fail closed (set-level)
    out.push({index: li, label: labels[li], startFrame: caps[at].startFrame - sceneStart});
    ci = at + toks.length; // advance past the matched run
  }
  return out;
}
