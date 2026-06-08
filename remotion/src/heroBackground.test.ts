import {describe, expect, it} from 'vitest';
import {heroBackground} from '../../templates/heroBackground';
import type {Palette} from './schema';

// A palette with a distinctive (non-black) background + white foreground so the
// assertions can locate the tokens inside the returned gradient string.
const PALETTE: Palette = {
  background: '#102030',
  foreground: '#ffffff',
  accent: '#ffe600',
  muted: '#9ca3af',
};

describe('heroBackground', () => {
  it('returns a gradient, not the bare solid fill', () => {
    const bg = heroBackground(PALETTE);
    expect(bg).toMatch(/gradient\(/); // a real background, not a flat color
    expect(bg).not.toBe(PALETTE.background); // the bug was `backgroundColor: bg`
    expect(bg).not.toMatch(/^#[0-9a-fA-F]{3,8}$/); // not a plain hex solid
  });

  it('is palette-driven via color-mix over the tokens', () => {
    const bg = heroBackground(PALETTE);
    expect(bg).toContain('color-mix'); // tints are derived, not precomputed
    expect(bg).toContain(PALETTE.background); // the base color is honored
    const shifted = heroBackground({...PALETTE, background: '#3a1d00'});
    expect(shifted).not.toBe(bg); // no hardcoded base color
  });

  it('keeps the center dark for text contrast (low lift toward foreground)', () => {
    // The spotlight lifts the center toward the foreground, but only slightly, so
    // the hero text never loses contrast. (fg = #ffffff in this palette.)
    const bg = heroBackground(PALETTE);
    const lifts = [...bg.matchAll(/#ffffff\s+(\d+)%/g)].map((m) => Number(m[1]));
    expect(lifts.length).toBeGreaterThan(0); // it does lift toward fg
    expect(Math.max(...lifts)).toBeLessThanOrEqual(20); // but stays subtle
  });

  it('is deterministic for the same palette', () => {
    expect(heroBackground(PALETTE)).toBe(heroBackground(PALETTE));
  });
});
