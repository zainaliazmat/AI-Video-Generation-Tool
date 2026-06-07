/**
 * heroBackground — a palette-driven background for the full-text hero cards
 * (hook / stat / outro). Replaces the old flat `backgroundColor:
 * theme.palette.background` fill, which rendered pure black on the default
 * palette — so all-stat videos came out ~99% black.
 *
 * Pure function of the palette, so it re-themes for free and is unit-tested
 * without a DOM. Three candidate treatments are kept behind `variant` for the
 * reviewer's pixel bake-off; once one is chosen the others can be dropped. Every
 * color is derived from a palette token via CSS color-mix (Chromium supports
 * it), and the center stays dark/low-lift so the hero text keeps its contrast.
 */
import type {Palette} from '../remotion/src/schema';

export const HERO_BACKGROUND_VARIANTS = ['A', 'B', 'C'] as const;
export type HeroBackgroundVariant = (typeof HERO_BACKGROUND_VARIANTS)[number];

/**
 * The variant the hero cards render today. Kept as one named knob so the three
 * cards stay in lockstep and the reviewer's pixel pick lands in a single place.
 * During the bake-off this is flipped A/B/C between bundles; once the reviewer
 * rules, collapse to the chosen variant and drop the unused ones.
 */
export const HERO_BACKGROUND_DEFAULT: HeroBackgroundVariant = 'B';

/** Tint `base` toward `other` by `pct`% — palette-driven, no precomputed hex. */
const mix = (base: string, other: string, pct: number): string =>
  `color-mix(in srgb, ${base}, ${other} ${pct}%)`;

const assertNever = (x: never): never => {
  throw new Error(`Unknown hero background variant: ${String(x)}`);
};

export function heroBackground(
  palette: Palette,
  variant: HeroBackgroundVariant,
): string {
  const {background: bg, foreground: fg, accent, muted} = palette;
  switch (variant) {
    // A — minimal vertical gradient: a soft top sheen into the base, with a
    // faint muted floor. Flattest, lowest banding risk.
    case 'A':
      return `linear-gradient(180deg, ${mix(bg, fg, 8)} 0%, ${bg} 58%, ${mix(bg, muted, 10)} 100%)`;
    // B — radial spotlight behind the text + darkened edges (vignette). Glow-
    // dominant on dark palettes, vignette-dominant on light ones.
    case 'B':
      return `radial-gradient(125% 80% at 50% 40%, ${mix(bg, fg, 12)} 0%, ${bg} 48%, ${mix(bg, '#000000', 45)} 100%)`;
    // C — layered: a brand accent wash in the top-right corner over a muted base
    // gradient. Accent-driven, so it re-themes hardest; center kept dark.
    case 'C':
      return [
        `radial-gradient(70% 45% at 82% 16%, ${mix(bg, accent, 16)} 0%, transparent 72%)`,
        `linear-gradient(180deg, ${mix(bg, muted, 12)} 0%, ${bg} 70%)`,
      ].join(', ');
    default:
      return assertNever(variant);
  }
}
