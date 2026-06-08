/**
 * Curated label → emoji glyph for the enumeration layout (the FLOOR; design §3).
 * Emoji are license-clean (Unicode, not copyrighted) and match the proven
 * `stat.icon` convention; the front-loaded headless-Chromium still confirmed they
 * render in color at size. Unknown labels fall back to a neutral, semantically-
 * empty mark — a meaningless mark beats a wrong specific icon (gradient-as-floor).
 *
 * NOTE: the consuming component MUST set an explicit text `color` on the glyph
 * span (e.g. theme.palette.muted) — color emoji carry their own color, but the
 * monochrome FALLBACK_ICON inherits text color, so without it the dot renders
 * black-on-dark and disappears (caught at the emoji still).
 *
 * Pure + deterministic → unit-tested. Plurals fold to the singular key.
 */
const CURATED: Record<string, string> = {
  sun: '☀️', moon: '🌙', planet: '🪐', earth: '🌍', mars: '🔴',
  star: '⭐', comet: '☄️', meteor: '☄️', eclipse: '🌑', phase: '🌓',
  galaxy: '🌌', telescope: '🔭', rocket: '🚀', satellite: '🛰️',
  cloud: '☁️', rain: '🌧️', snow: '❄️', fire: '🔥', water: '💧',
  ocean: '🌊', mountain: '⛰️', tree: '🌳', leaf: '🍃', clock: '🕰️',
  gear: '⚙️', light: '💡', book: '📖', brain: '🧠', heart: '❤️',
};

export const FALLBACK_ICON = '●';

/** Singular candidates to try, in order. English plural→singular is ambiguous
 * ("phases"→"phase" strips only -s; "boxes"→"box" strips -es), so we try the
 * narrower strip first and return the first that hits the curated table. */
function candidates(k: string): string[] {
  const out = [k];
  if (k.endsWith('ies') && k.length > 4) out.push(k.slice(0, -3) + 'y'); // berries→berry
  if (k.endsWith('s') && k.length > 3) out.push(k.slice(0, -1)); // phases→phase, planets→planet
  if (k.endsWith('es') && k.length > 4) out.push(k.slice(0, -2)); // boxes→box
  return out;
}

export function iconForLabel(label: string): string {
  const k = label.trim().toLowerCase();
  for (const c of candidates(k)) {
    if (CURATED[c]) return CURATED[c];
  }
  return FALLBACK_ICON;
}
