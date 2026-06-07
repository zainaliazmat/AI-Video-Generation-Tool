import {describe, expect, it} from 'vitest';
import {
  heroBackground,
  HERO_BACKGROUND_VARIANTS,
  HERO_BACKGROUND_DEFAULT,
} from '../../templates/heroBackground';
import type {Palette} from './schema';

// The default (and, today, only) production palette — the one that renders pure
// black today. The helper must turn this into a palette-driven background.
const DARK: Palette = {
  background: '#000000',
  foreground: '#FFFFFF',
  accent: '#FFE600',
  muted: '#9CA3AF',
};

describe('heroBackground', () => {
  it('returns a gradient, not the bare solid fill, for every variant', () => {
    for (const v of HERO_BACKGROUND_VARIANTS) {
      const bg = heroBackground(DARK, v);
      expect(bg).toMatch(/gradient\(/); // a real background, not a flat color
      expect(bg).not.toBe(DARK.background); // the bug was `backgroundColor: bg`
      expect(bg).not.toMatch(/^#[0-9a-fA-F]{3,8}$/); // not a plain hex solid
    }
  });

  it('is palette-driven: changing the background token changes every variant', () => {
    for (const v of HERO_BACKGROUND_VARIANTS) {
      const base = heroBackground(DARK, v);
      const shifted = heroBackground({...DARK, background: '#101820'}, v);
      expect(shifted).not.toBe(base); // no hardcoded base color
    }
  });

  it('wires the accent token: the brand-forward variant reflects accent changes', () => {
    const base = heroBackground(DARK, 'C');
    const shifted = heroBackground({...DARK, accent: '#3366FF'}, 'C');
    expect(shifted).not.toBe(base);
  });

  it('produces a distinct treatment per variant', () => {
    const outs = HERO_BACKGROUND_VARIANTS.map((v) => heroBackground(DARK, v));
    expect(new Set(outs).size).toBe(HERO_BACKGROUND_VARIANTS.length);
  });

  it('is deterministic for the same palette + variant', () => {
    expect(heroBackground(DARK, 'B')).toBe(heroBackground(DARK, 'B'));
  });

  it('exposes a default variant that is one of the known variants', () => {
    expect(HERO_BACKGROUND_VARIANTS).toContain(HERO_BACKGROUND_DEFAULT);
  });
});
