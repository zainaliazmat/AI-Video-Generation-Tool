import {describe, it, expect} from 'vitest';
import {deriveCaptionSuppressRanges, isFrameSuppressed} from './captions-suppress';

// The enumeration manifest sets rendersOwnText:true (asserted in
// enumeration-manifest.test.ts + test_manifest.py), so Video.tsx's ownsText
// predicate returns true for it and the global karaoke caption is suppressed over
// its span — the rendersOwnText cash-in, needing NO suppression-code change. Here
// we exercise the geometry with a predicate keyed exactly as Video.tsx keys it
// (own-text for the enumeration card, not for footage scenes).
const ownsText = (id: string | undefined) => id === 'enumeration' || id === 'hook';

describe('enumeration caption suppression', () => {
  it('suppresses captions over an enumeration scene span but not an adjacent footage scene', () => {
    const scenes = [
      {template: 'enumeration', startFrame: 100, durationInFrames: 90},
      {template: 'scene', startFrame: 190, durationInFrames: 60}, // footage → captions stay
    ];
    const ranges = deriveCaptionSuppressRanges(scenes, ownsText);
    expect(ranges).toEqual([[100, 190]]);
    expect(isFrameSuppressed(120, ranges)).toBe(true);
    expect(isFrameSuppressed(190, ranges)).toBe(false); // half-open: footage scene's first frame
    expect(isFrameSuppressed(220, ranges)).toBe(false); // inside the footage scene
  });
});
