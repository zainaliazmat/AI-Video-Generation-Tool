/**
 * Per-item entrance state for the enumeration reveal. Unlike the hook (dim-from-
 * frame-0), enumeration items are ABSENT until their reveal frame, then pop in
 * (fade + rise + slight scale) — the "revealed one-by-one" semantic. Pure +
 * remotion-free (its own clamped ease) so it is unit-testable and matches the gate.
 */
export interface ItemRevealState {
  opacity: number;
  scale: number;
  translateY: number;
}

const ENTER = 9; // frames to fully enter

function easeOutCubic(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - c, 3);
}

export function itemRevealState(frame: number, startFrame: number): ItemRevealState {
  const e = easeOutCubic((frame - startFrame) / ENTER);
  return {opacity: e, scale: 0.85 + 0.15 * e, translateY: (1 - e) * 28};
}
