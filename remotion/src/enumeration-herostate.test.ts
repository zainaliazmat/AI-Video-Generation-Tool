import {describe, it, expect} from 'vitest';
import {activeIndex, heroPresence, heroLabelOpacity} from '../../templates/enumeration/heroState';

const STARTS = [30, 50, 70, 90, 110]; // 20-frame gaps (~0.67s at 30fps), the tight beat

describe('activeIndex', () => {
  it('is -1 before the first reveal', () => {
    expect(activeIndex(0, STARTS)).toBe(-1);
  });
  it('is the last item whose start has passed', () => {
    expect(activeIndex(55, STARTS)).toBe(1); // sun(0) revealed, moon(1) active
    expect(activeIndex(200, STARTS)).toBe(4); // last item holds to the end
  });
});

describe('heroPresence', () => {
  it('is 0 before the item reveals', () => {
    expect(heroPresence(20, 1, STARTS)).toBe(0);
  });
  it('is fully present mid-window (after its entrance, before the next reveal)', () => {
    expect(heroPresence(68, 1, STARTS)).toBeCloseTo(1, 5); // moon settled, planets not yet
  });
  it('crossfade completes WITHIN the tight gap and never leaves two heroes fully opaque', () => {
    for (let f = 30; f <= 130; f++) {
      const full = STARTS.map((_, i) => heroPresence(f, i, STARTS)).filter((p) => p > 0.999);
      expect(full.length).toBeLessThanOrEqual(1); // at most one hero at full opacity
    }
  });
  it('the last item stays present to the end (no next item to fade it out)', () => {
    expect(heroPresence(300, 4, STARTS)).toBeCloseTo(1, 5);
  });
});

describe('heroLabelOpacity', () => {
  // The hero IMAGE cross-dissolves (heroPresence overlaps two heroes mid-transition,
  // which reads fine for centered imagery). The LABEL must NOT: two names at the same
  // baseline overprint into garbled doubled text. So labels fade THROUGH NOTHING —
  // the outgoing name reaches 0 before the incoming one begins.
  it('is 0 before the item reveals', () => {
    expect(heroLabelOpacity(20, 1, STARTS)).toBe(0);
  });
  it('is fully opaque mid-window (its name settled, before it fades out into the next reveal)', () => {
    expect(heroLabelOpacity(60, 1, STARTS)).toBeCloseTo(1, 5);
  });
  it('NEVER shows two labels visible at once — no overprint at the shared baseline', () => {
    for (let f = 0; f <= 200; f++) {
      const visible = STARTS.map((_, i) => heroLabelOpacity(f, i, STARTS)).filter((o) => o > 0.001);
      expect(visible.length).toBeLessThanOrEqual(1);
    }
  });
  it('the outgoing label is fully gone by the next reveal frame', () => {
    expect(heroLabelOpacity(STARTS[1], 0, STARTS)).toBe(0); // Sun label gone exactly when Moon reveals
  });
  it('the last item label stays to the end (no next item to fade it out)', () => {
    expect(heroLabelOpacity(300, 4, STARTS)).toBeCloseTo(1, 5);
  });
});
