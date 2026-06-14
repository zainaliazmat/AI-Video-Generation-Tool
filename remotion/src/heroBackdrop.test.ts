/**
 * HeroBackdrop unit tests.
 *
 * These tests deliberately avoid rendering the React component (which requires
 * remotion hooks / a DOM) and instead exercise:
 *   - Exported constants (SCRIM_ALPHA, GRADIENT_OPACITY_WITH_CLIP)
 *   - heroBackdropGradientString() — the pure helper that exposes the gradient
 *     computation for testing without React
 *   - rendersOwnText in all three hero manifests
 *
 * Imports are from heroBackdropUtils (pure, no React/Remotion) so vitest can
 * run these without a DOM or JSX transform.
 */
import {describe, expect, it} from 'vitest';
import {
  SCRIM_ALPHA,
  GRADIENT_OPACITY_WITH_CLIP,
  heroBackdropGradientString,
} from '../../templates/heroBackdropUtils';
import {heroBackground} from '../../templates/heroBackground';
import type {Palette} from './schema';

import hookManifest from '../../templates/hook/manifest.json';
import statManifest from '../../templates/stat/manifest.json';
import outroManifest from '../../templates/outro/manifest.json';

const PALETTE: Palette = {
  background: '#102030',
  foreground: '#ffffff',
  accent: '#ffe600',
  muted: '#9ca3af',
};

// ---------------------------------------------------------------------------
// Exported constants
// ---------------------------------------------------------------------------

describe('HeroBackdrop constants', () => {
  it('SCRIM_ALPHA is in (0, 1)', () => {
    expect(SCRIM_ALPHA).toBeGreaterThan(0);
    expect(SCRIM_ALPHA).toBeLessThan(1);
  });

  it('GRADIENT_OPACITY_WITH_CLIP is in (0, 1) — clip must show through', () => {
    expect(GRADIENT_OPACITY_WITH_CLIP).toBeGreaterThan(0);
    expect(GRADIENT_OPACITY_WITH_CLIP).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// heroBackdropGradientString — no-clip mode is byte-identical to heroBackground
// ---------------------------------------------------------------------------

describe('heroBackdropGradientString', () => {
  it('at frame=0 is byte-equal to heroBackground(palette, 0)', () => {
    const fromHelper = heroBackdropGradientString(PALETTE, 0);
    const direct = heroBackground(PALETTE, 0);
    expect(fromHelper).toBe(direct);
  });

  it('at frame=75 (half-period) matches heroBackground at phase 0.5', () => {
    const fromHelper = heroBackdropGradientString(PALETTE, 75); // 75 / HERO_BREATH_PERIOD = 0.5
    const direct = heroBackground(PALETTE, 0.5);
    expect(fromHelper).toBe(direct);
  });

  it('varies with frame — the breathing effect is live', () => {
    const f0 = heroBackdropGradientString(PALETTE, 0);
    const f38 = heroBackdropGradientString(PALETTE, 38); // ~quarter-period
    expect(f0).not.toBe(f38);
  });

  it('is deterministic for the same palette + frame', () => {
    expect(heroBackdropGradientString(PALETTE, 30)).toBe(heroBackdropGradientString(PALETTE, 30));
  });
});

// ---------------------------------------------------------------------------
// Hero manifests — rendersOwnText gate
// ---------------------------------------------------------------------------

describe('hero manifests rendersOwnText', () => {
  it('hook manifest has rendersOwnText: true', () => {
    expect(hookManifest.rendersOwnText).toBe(true);
  });

  it('stat manifest has rendersOwnText: true', () => {
    expect(statManifest.rendersOwnText).toBe(true);
  });

  it('outro manifest has rendersOwnText: true', () => {
    expect(outroManifest.rendersOwnText).toBe(true);
  });
});
