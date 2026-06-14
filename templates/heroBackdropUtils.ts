/**
 * Pure (non-React) utilities for HeroBackdrop — exported separately so that
 * vitest test files can import them without pulling in the React / Remotion
 * render tree (which requires a browser-like environment).
 */
import type {Palette} from '../remotion/src/schema';
import {heroBackground, HERO_BREATH_PERIOD} from './heroBackground';

/** Dark scrim opacity over a background clip — keeps text legible. Tunable;
 * validated by the T4 contrast gate. */
export const SCRIM_ALPHA = 0.55;

/** Opacity applied to the gradient layer when a clip is present — lets the
 * clip show through while the radial spotlight still pools light around the
 * text. Must be < 1 so the clip is visible. */
export const GRADIENT_OPACITY_WITH_CLIP = 0.72;

/** Pure helper: returns the gradient string for the given palette + frame.
 * Exported for unit testing without needing to render the React component. */
export function heroBackdropGradientString(palette: Palette, frame: number): string {
  return heroBackground(palette, frame / HERO_BREATH_PERIOD);
}
