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
 * `phase` (a cycle fraction, frame / HERO_BREATH_PERIOD) gently BREATHES the
 * spotlight — radius, vertical center, and lift oscillate on a slow sine — so the
 * long held states between entrances are never frozen to the pixel. The motion is
 * sub-legibility (the center stays dark and it never fights the words), and at
 * phase 0 the gradient is identical to the static spotlight, so the first frame
 * of every card is the approved still.
 *
 * Pure function of (palette, phase), so it re-themes for free and is unit-tested
 * without a DOM; the components feed it the current frame.
 */
import type {Palette} from '../remotion/src/schema';

/** Frames per breath cycle (~5s at 30fps) — slow and calm, well under legibility. */
export const HERO_BREATH_PERIOD = 150;

/** Tint `base` toward `other` by `pct`% — palette-driven, no precomputed hex. */
const mix = (base: string, other: string, pct: number): string =>
  `color-mix(in srgb, ${base}, ${other} ${pct}%)`;

export function heroBackground(palette: Palette, phase = 0): string {
  const {background: bg, foreground: fg} = palette;
  const wob = Math.sin(phase * Math.PI * 2); // -1..1, exactly 0 at phase 0
  const rx = 125 + wob * 8; // the pool breathes wider/narrower …
  const ry = 80 + wob * 6;
  const cy = 40 + wob * 3; // … and drifts gently up and down …
  const lift = 12 + wob * 2; // … as the center glow softly pulses (≤14% → legible).
  return `radial-gradient(${rx}% ${ry}% at 50% ${cy}%, ${mix(bg, fg, lift)} 0%, ${bg} 48%, ${mix(bg, '#000000', 45)} 100%)`;
}
