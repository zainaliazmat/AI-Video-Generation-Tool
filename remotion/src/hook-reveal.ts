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
