import {describe, it, expect} from 'vitest';
import {itemRevealState} from '../../templates/enumeration/reveal';

// window [start, end): end is the next item's reveal (or a fixed last-item window).
describe('itemRevealState', () => {
  it('is hidden before its reveal frame', () => {
    const s = itemRevealState(0, 30, 60);
    expect(s.opacity).toBe(0);
    expect(s.translateY).toBeGreaterThan(0);
  });
  it('overshoots scale above 1 mid-entrance, then settles to exactly 1', () => {
    const peak = itemRevealState(36, 30, 90); // ~0.6 into a 10-frame enter → past 1
    expect(peak.scale).toBeGreaterThan(1);
    const settled = itemRevealState(60, 30, 90); // well after enter
    expect(settled.scale).toBeCloseTo(1, 5);
    expect(settled.translateY).toBeCloseTo(0, 5);
    expect(settled.rotate).toBeCloseTo(0, 5);
  });
  it('opacity is monotonic up over the entrance', () => {
    const a = itemRevealState(33, 30, 90);
    const b = itemRevealState(37, 30, 90);
    expect(a.opacity).toBeGreaterThan(0);
    expect(b.opacity).toBeGreaterThan(a.opacity);
  });
  it('ACCENT DECAYS, not holds: lit early in the window, ~0 by end (next item reveals)', () => {
    const start = 30, end = 90;
    const before = itemRevealState(start - 2, start, end);
    const lit = itemRevealState(start + Math.round((end - start) * 0.4), start, end);
    const atEnd = itemRevealState(end, start, end);
    expect(before.accent).toBe(0);
    expect(lit.accent).toBeGreaterThan(0.9);
    expect(atEnd.accent).toBeLessThan(0.05); // decayed before the next item lights
  });
  it('accent stays well-formed for a NARROW window (closely spaced items)', () => {
    const s = itemRevealState(35, 33, 39); // 6-frame window
    expect(s.accent).toBeGreaterThanOrEqual(0);
    expect(s.accent).toBeLessThanOrEqual(1);
  });
});
