/**
 * Caption-suppression geometry — the load-bearing logic behind hiding the global
 * karaoke caption over full-text hero cards (hook/stat/outro). Kept as PURE,
 * render-free functions so the off-by-one-prone span derivation and the half-open
 * frame test can be unit-tested without spinning up Remotion. Video.tsx and
 * Captions.tsx are the only call sites.
 */
import type {Scene} from './schema';

/** An absolute, half-open [start, end) frame span. */
export type FrameRange = readonly [number, number];

/** Minimal scene shape this module needs (decoupled from the full Scene type). */
type SceneSpan = Pick<Scene, 'template' | 'startFrame' | 'durationInFrames'>;

/**
 * The [start, end) spans of scenes whose template renders its OWN full text, per
 * the `ownsText` predicate (driven by `manifest.rendersOwnText` at the call site).
 * Spans are half-open so they tile exactly against the contiguous scene layout:
 * scene i's end == scene i+1's start, and the boundary frame belongs to i+1.
 */
export function deriveCaptionSuppressRanges(
  scenes: readonly SceneSpan[],
  ownsText: (templateId: string | undefined) => boolean,
): FrameRange[] {
  return scenes.flatMap((s) =>
    ownsText(s.template)
      ? [[s.startFrame, s.startFrame + s.durationInFrames] as FrameRange]
      : [],
  );
}

/**
 * True when `frame` falls inside any range, treating each as half-open [start,
 * end): the start frame is suppressed, the end frame is NOT (it's the next
 * scene's first frame). This is what keeps suppression from bleeding one frame
 * into an adjacent footage scene.
 */
export function isFrameSuppressed(
  frame: number,
  ranges: ReadonlyArray<FrameRange>,
): boolean {
  return ranges.some(([start, end]) => frame >= start && frame < end);
}
