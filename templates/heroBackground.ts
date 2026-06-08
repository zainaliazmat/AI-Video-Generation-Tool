/**
 * heroBackground — the palette-driven background for the full-text hero cards
 * (hook / stat / outro). Replaces the old flat `backgroundColor:
 * theme.palette.background` fill, which rendered pure black on the default
 * palette so all-stat videos came out ~99% black.
 *
 * A radial spotlight pools light behind the hero text: the center lifts slightly
 * toward the foreground and the edges darken into a vignette, so the card reads
 * as intentional while the center stays dark enough to keep the text legible. On
 * a light palette the same construction inverts to a soft vignette.
 *
 * Pure function of the palette, so it re-themes for free and is unit-tested
 * without a DOM.
 */
import type {Palette} from '../remotion/src/schema';

/** Tint `base` toward `other` by `pct`% — palette-driven, no precomputed hex. */
const mix = (base: string, other: string, pct: number): string =>
  `color-mix(in srgb, ${base}, ${other} ${pct}%)`;

export function heroBackground(palette: Palette): string {
  const {background: bg, foreground: fg} = palette;
  // Center lifts 12% toward the foreground (subtle — text stays legible); the
  // midpoint is the base color; the edges darken 45% for the vignette.
  return `radial-gradient(125% 80% at 50% 40%, ${mix(bg, fg, 12)} 0%, ${bg} 48%, ${mix(bg, '#000000', 45)} 100%)`;
}
