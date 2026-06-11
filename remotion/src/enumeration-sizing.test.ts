import {describe, it, expect} from 'vitest';
import {enumerationSizing, listBandHeight} from '../../templates/enumeration/sizing';

describe('enumerationSizing', () => {
  const BAND = listBandHeight();

  it('shrinks monotonically as item count grows', () => {
    const a = enumerationSizing(2, BAND), b = enumerationSizing(4, BAND), c = enumerationSizing(6, BAND);
    expect(a.iconSize).toBeGreaterThan(b.iconSize);
    expect(b.iconSize).toBeGreaterThan(c.iconSize);
    expect(a.labelSize).toBeGreaterThan(c.labelSize);
    expect(a.rowGap).toBeGreaterThanOrEqual(c.rowGap);
  });
  it('clamps below 2 and above 6', () => {
    expect(enumerationSizing(1, BAND)).toEqual(enumerationSizing(2, BAND));
    expect(enumerationSizing(9, BAND)).toEqual(enumerationSizing(6, BAND));
  });
  it('6 rows fit within the list band without overflow', () => {
    const s = enumerationSizing(6, BAND);
    const rowH = Math.max(s.iconSize, s.labelSize * 1.2);
    const total = 6 * rowH + 5 * s.rowGap;
    expect(total).toBeLessThanOrEqual(BAND); // sized to the list band, not the full frame
  });
  it('fewer items are substantially larger (fills, not tiny)', () => {
    expect(enumerationSizing(2, BAND).iconSize).toBeGreaterThanOrEqual(180);
  });
});

describe('enumerationSizing list-band fit', () => {
  const BAND = listBandHeight(); // the SAME helper the Component feeds enumerationSizing

  it('fits 6 rows within the band height (icon + gap stack does not overflow)', () => {
    const sz = enumerationSizing(6, BAND);
    const stack = 6 * sz.iconSize + 5 * sz.rowGap;
    expect(stack).toBeLessThanOrEqual(BAND);
  });
  it('still shrinks monotonically as items increase', () => {
    const a = enumerationSizing(2, BAND);
    const b = enumerationSizing(6, BAND);
    expect(b.iconSize).toBeLessThan(a.iconSize);
    expect(b.labelSize).toBeLessThan(a.labelSize);
  });
});
