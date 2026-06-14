// Scene-relative time helpers for the per-scene player's custom controls.
//
// The per-scene <Player> is fed the FULL composition (durationInFrames =
// spec.meta.durationInFrames) so it can address absolute scene frames, with
// inFrame/outFrame pinning playback to the scene span. Remotion's native
// controls therefore read the whole video's length (e.g. 0:42) with the rest of
// the bar greyed — confusing for a 5.8s scene. These pure helpers re-base the
// readout + scrubber to the scene span so the player shows 0 → scene length.

/**
 * Absolute composition frame → scene-relative frame, clamped to [0, dur-1].
 * outFrame is inclusive (start + dur - 1), so the max in-span relative is dur-1.
 */
export function clampRelative(
  currentFrame: number,
  startFrame: number,
  durationInFrames: number,
): number {
  const rel = currentFrame - startFrame;
  const max = Math.max(durationInFrames - 1, 0);
  return Math.min(Math.max(rel, 0), max);
}

/**
 * Format a frame count as a clock. Scenes are short, so sub-minute spans show
 * one-decimal seconds ("5.8s") to match the under-player caption; ≥60s falls
 * back to m:ss. Never negative.
 */
export function formatSceneClock(frame: number, fps: number): string {
  const seconds = Math.max(0, frame) / fps;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
