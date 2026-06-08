import {describe, it, expect} from 'vitest';
import {itemRevealState} from '../../templates/enumeration/reveal';

describe('itemRevealState', () => {
  it('is hidden before its reveal frame', () => {
    const s = itemRevealState(0, 30);
    expect(s.opacity).toBe(0);
    expect(s.translateY).toBeGreaterThan(0);
  });
  it('is fully settled well after its reveal frame', () => {
    const s = itemRevealState(60, 30);
    expect(s.opacity).toBeCloseTo(1, 5);
    expect(s.scale).toBeCloseTo(1, 5);
    expect(s.translateY).toBeCloseTo(0, 5);
  });
  it('is partially entered mid-transition (monotonic opacity)', () => {
    const a = itemRevealState(32, 30);
    const b = itemRevealState(35, 30);
    expect(a.opacity).toBeGreaterThan(0);
    expect(a.opacity).toBeLessThan(1);
    expect(b.opacity).toBeGreaterThan(a.opacity);
  });
});
