import {describe, it, expect} from 'vitest';
import {iconForLabel, FALLBACK_ICON} from '../../templates/enumeration/icons';

describe('iconForLabel', () => {
  it('maps curated labels case/space-insensitively', () => {
    expect(iconForLabel('Sun')).toBe('☀️');
    expect(iconForLabel('  moon ')).toBe('🌙');
  });
  it('maps plurals to the singular curated glyph', () => {
    expect(iconForLabel('Planets')).toBe(iconForLabel('planet'));
    expect(iconForLabel('phases')).toBe(iconForLabel('phase'));
    expect(iconForLabel('Planets')).not.toBe(FALLBACK_ICON);
  });
  it('falls back to a neutral mark for unknown labels', () => {
    expect(iconForLabel('xyzzy')).toBe(FALLBACK_ICON);
    expect(FALLBACK_ICON).toBe('●');
  });
});
