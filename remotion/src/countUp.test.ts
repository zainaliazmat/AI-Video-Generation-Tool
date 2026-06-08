import {describe, expect, it} from 'vitest';
import {parseCountUp, formatCount} from '../../templates/countUp';

describe('parseCountUp', () => {
  it('parses a plain integer', () => {
    expect(parseCountUp('82')).toEqual({target: 82, suffix: '', useCommas: false});
    expect(parseCountUp('100')).toEqual({target: 100, suffix: '', useCommas: false});
  });

  it('parses a leading integer with a static word suffix', () => {
    expect(parseCountUp('93 billion')).toEqual({
      target: 93,
      suffix: ' billion',
      useCommas: false,
    });
  });

  it('parses a thousands-separated integer and remembers the commas', () => {
    expect(parseCountUp('37,700')).toEqual({
      target: 37700,
      suffix: '',
      useCommas: true,
    });
  });

  it('parses a leading integer with a +unit suffix', () => {
    expect(parseCountUp('60+ feet')).toEqual({
      target: 60,
      suffix: '+ feet',
      useCommas: false,
    });
  });

  it('falls back (null) for ranges', () => {
    expect(parseCountUp('14-17 feet')).toBeNull();
  });

  it('falls back (null) for decimals and scientific notation', () => {
    expect(parseCountUp('73.5 km/s/Mpc')).toBeNull();
    expect(parseCountUp('1.5×10^34')).toBeNull();
  });

  it('falls back (null) when there is no leading digit', () => {
    expect(parseCountUp('many')).toBeNull();
    expect(parseCountUp('')).toBeNull();
  });

  it('round-trips: parsed target + suffix re-render the exact source string', () => {
    for (const v of ['82', '100', '93 billion', '37,700', '60+ feet']) {
      const p = parseCountUp(v);
      expect(p).not.toBeNull();
      expect(formatCount(p!.target, p!.useCommas) + p!.suffix).toBe(v);
    }
  });
});

describe('formatCount', () => {
  it('groups thousands when requested', () => {
    expect(formatCount(37700, true)).toBe('37,700');
    expect(formatCount(1500, true)).toBe('1,500');
    expect(formatCount(1234567, true)).toBe('1,234,567');
    expect(formatCount(0, true)).toBe('0');
  });

  it('omits grouping when not requested', () => {
    expect(formatCount(93, false)).toBe('93');
    expect(formatCount(37700, false)).toBe('37700');
  });
});
