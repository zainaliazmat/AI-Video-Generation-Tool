import {describe, it, expect} from 'vitest';
import {clampRelative, formatSceneClock} from './sceneTime';

// The per-scene player shows scene-RELATIVE time (0 → scene length), not the
// full composition time. These pure helpers back that readout + the scoped
// scrubber so the display can't drift from the playback span.

describe('clampRelative — absolute composition frame → scene-relative frame', () => {
  it('maps the scene start to relative 0', () => {
    expect(clampRelative(174, 174, 163)).toBe(0);
  });

  it('maps a mid-scene frame to its offset from the start', () => {
    expect(clampRelative(174 + 50, 174, 163)).toBe(50);
  });

  it('clamps below the start to 0 (player parked before the span)', () => {
    expect(clampRelative(100, 174, 163)).toBe(0);
  });

  it('clamps past the end to the last in-span frame (durationInFrames - 1)', () => {
    // outFrame is inclusive = start + dur - 1, so the max relative is dur - 1.
    expect(clampRelative(174 + 999, 174, 163)).toBe(162);
  });

  it('first scene (startFrame 0): relative equals the absolute frame within span', () => {
    expect(clampRelative(120, 0, 174)).toBe(120);
    expect(clampRelative(173, 0, 174)).toBe(173);
    expect(clampRelative(500, 0, 174)).toBe(173); // clamped to dur-1
  });

  it('degenerate single-frame span never returns a negative max', () => {
    expect(clampRelative(5, 10, 1)).toBe(0);
    expect(clampRelative(50, 10, 1)).toBe(0);
  });
});

describe('formatSceneClock — short-scene seconds, minutes only when long', () => {
  it('shows one-decimal seconds for sub-minute scenes (matches the caption style)', () => {
    expect(formatSceneClock(174, 30)).toBe('5.8s'); // the potoo hook
    expect(formatSceneClock(0, 30)).toBe('0.0s');
    expect(formatSceneClock(45, 30)).toBe('1.5s');
  });

  it('rounds to one decimal', () => {
    expect(formatSceneClock(50, 30)).toBe('1.7s'); // 1.666… → 1.7
  });

  it('switches to m:ss at/over 60s', () => {
    expect(formatSceneClock(1800, 30)).toBe('1:00'); // 60.0s
    expect(formatSceneClock(2010, 30)).toBe('1:07'); // 67.0s
  });

  it('never shows negative time', () => {
    expect(formatSceneClock(-30, 30)).toBe('0.0s');
  });
});
