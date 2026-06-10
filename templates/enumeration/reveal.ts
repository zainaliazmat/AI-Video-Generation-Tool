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

// Back-ease overshoot: 0 at 0, peaks ~1.20 near 0.62, settles to exactly 1 at >=1.
// s is dialled past the default 1.70158 so the entrance reads as a real pop (not a
// soft fade) — see scale below, where the 1.20 pop peak yields a ~1.07 scale peak.
function easeOutBack(t: number): number {
  const c = clamp01(t);
  const s = 2.6;
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
    scale: 0.65 + 0.35 * pop, // 0.65 → peak ~1.07 → settles to 1
    translateY: (1 - enter) * 40,
    rotate: (1 - enter) * -2,
    accent: Math.max(0, accent),
  };
}
