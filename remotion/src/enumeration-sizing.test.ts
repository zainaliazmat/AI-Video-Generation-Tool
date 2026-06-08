import {describe, it, expect} from 'vitest';
import {enumerationSizing} from '../../templates/enumeration/sizing';

describe('enumerationSizing', () => {
  it('shrinks monotonically as item count grows', () => {
    const a = enumerationSizing(2), b = enumerationSizing(4), c = enumerationSizing(6);
    expect(a.iconSize).toBeGreaterThan(b.iconSize);
    expect(b.iconSize).toBeGreaterThan(c.iconSize);
    expect(a.labelSize).toBeGreaterThan(c.labelSize);
    expect(a.rowGap).toBeGreaterThanOrEqual(c.rowGap);
  });
  it('clamps below 2 and above 6', () => {
    expect(enumerationSizing(1)).toEqual(enumerationSizing(2));
    expect(enumerationSizing(9)).toEqual(enumerationSizing(6));
  });
  it('6 rows fit the 1920px frame without overflow', () => {
    const s = enumerationSizing(6);
    const rowH = Math.max(s.iconSize, s.labelSize * 1.2);
    const total = 6 * rowH + 5 * s.rowGap;
    expect(total).toBeLessThanOrEqual(1500); // generous top/bottom margin under 1920
  });
  it('fewer items are substantially larger (fills, not tiny)', () => {
    expect(enumerationSizing(2).iconSize).toBeGreaterThanOrEqual(180);
  });
});
