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
const LABEL_FADE = 5; // hero-label fade half-window (short: the name swaps cleanly, never lingers)

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

/** 0..1 opacity for item i's hero LABEL. Distinct from heroPresence (the image): the
 *  image cross-dissolves, but two labels at the same centered baseline overprint into
 *  garbled doubled text. So labels fade THROUGH NOTHING — the outgoing name fades fully
 *  to 0 by the next reveal frame, and the incoming name only begins to fade in AT that
 *  frame. No two labels are ever visible at once (asserted in the test). The image
 *  crossfade is untouched; only the text swap changes. */
export function heroLabelOpacity(frame: number, i: number, starts: number[]): number {
  if (frame < starts[i]) return 0;
  const hasNext = i + 1 < starts.length;
  const nextStart = hasNext ? starts[i + 1] : Infinity;
  if (frame >= nextStart) return 0; // the next item owns the label from its reveal on
  const gapIn = i > 0 ? starts[i] - starts[i - 1] : LABEL_FADE;
  const gapOut = hasNext ? nextStart - starts[i] : Infinity;
  const fadeIn = Math.max(1, Math.min(LABEL_FADE, gapIn));
  const fadeOut = Math.max(1, Math.min(LABEL_FADE, gapOut));
  const up = clamp01((frame - starts[i]) / fadeIn); // fade in from this item's reveal
  const down = hasNext ? clamp01((nextStart - frame) / fadeOut) : 1; // fade out into the next reveal
  return clamp01(Math.min(up, down));
}
