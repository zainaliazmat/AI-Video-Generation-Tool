import {describe, expect, it} from 'vitest';
import {
  deriveCaptionSuppressRanges,
  isFrameSuppressed,
  type FrameRange,
} from './captions-suppress';

// A contiguous, gap-filling layout mirroring assemble.scene_spans: hook[0,184),
// footage[184,320), stat[320,500). hook + stat own their text; footage does not.
const SCENES = [
  {template: 'hook', startFrame: 0, durationInFrames: 184},
  {template: 'scene', startFrame: 184, durationInFrames: 136},
  {template: 'stat', startFrame: 320, durationInFrames: 180},
];
const ownsText = (id: string | undefined) => id === 'hook' || id === 'stat';

describe('deriveCaptionSuppressRanges', () => {
  it('emits a span only for templates that render their own text', () => {
    expect(deriveCaptionSuppressRanges(SCENES, ownsText)).toEqual([
      [0, 184],
      [320, 500],
    ]);
  });

  it('omits footage scenes entirely (no span)', () => {
    const footageOnly = [{template: 'scene', startFrame: 0, durationInFrames: 90}];
    expect(deriveCaptionSuppressRanges(footageOnly, ownsText)).toEqual([]);
  });

  it('treats an absent/unknown template as not-owning-text', () => {
    const scenes = [{template: undefined, startFrame: 0, durationInFrames: 90}];
    expect(deriveCaptionSuppressRanges(scenes, ownsText)).toEqual([]);
  });
});

describe('isFrameSuppressed', () => {
  const ranges = deriveCaptionSuppressRanges(SCENES, ownsText); // [[0,184],[320,500]]

  it('hides a caption frame inside a hero span', () => {
    expect(isFrameSuppressed(90, ranges)).toBe(true); // mid-hook
    expect(isFrameSuppressed(400, ranges)).toBe(true); // mid-stat
  });

  it('shows a caption frame inside a footage span', () => {
    expect(isFrameSuppressed(250, ranges)).toBe(false); // mid-footage
  });

  it('is half-open at the boundary: start suppressed, end belongs to the next scene', () => {
    expect(isFrameSuppressed(0, ranges)).toBe(true); // hero start — suppressed
    // hook end == footage start (184): NOT suppressed, else footage loses a frame.
    expect(isFrameSuppressed(184, ranges)).toBe(false);
    expect(isFrameSuppressed(183, ranges)).toBe(true); // last hero frame — suppressed
    expect(isFrameSuppressed(320, ranges)).toBe(true); // stat start — suppressed
    expect(isFrameSuppressed(500, ranges)).toBe(false); // past stat end (exclusive)
  });

  it('shows everything when there are no ranges', () => {
    expect(isFrameSuppressed(42, [] as FrameRange[])).toBe(false);
  });
});
