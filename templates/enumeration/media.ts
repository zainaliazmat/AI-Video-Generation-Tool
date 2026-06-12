/**
 * Source-swappable media resolver for the enumeration hero. Cascade:
 * curated NASA PD image (resolved THROUGH the assets prop) -> designed lucide
 * icon -> neutral mark. The image and icon SOURCES are plain maps so vendoring
 * an icon subset or swapping the image set later is a localized change.
 * Pure + deterministic -> unit-tested. Reuses the plural-folding candidates()
 * from icons.ts. See media design doc Tier 2.
 *
 * resolveMedia(label, assets): the `assets` prop is the staticFile-resolved map
 * provided by the renderer (resolveAssets(manifest)). The src returned for an
 * image resolution is the RESOLVED URL from that map, NOT a hand-built
 * staticFile() string — this keeps installs relocatable (§15.1). Fail-closed:
 * if assets[IMAGE_MANIFEST[c]] is absent/falsy the cascade falls to the icon
 * layer, so a template missing an install still renders legibly.
 *
 * INVARIANT (asserted in the test): every IMAGE_MANIFEST key MUST also be an
 * ICON_MAP key. An image item's LIST row renders a small icon (not a thumbnail),
 * so a missing icon-map entry would show a blank mark under a full hero image.
 */
import {candidates} from './icons';

export type LucideName =
  | 'sun' | 'moon' | 'orbit' | 'globe' | 'circle' | 'star' | 'sparkle'
  | 'telescope' | 'rocket' | 'satellite' | 'cloud' | 'droplet' | 'flame'
  | 'waves' | 'mountain' | 'trees' | 'leaf' | 'clock' | 'cog' | 'lightbulb'
  | 'book-open' | 'brain' | 'heart';

export type MediaResolution =
  | {kind: 'image'; src: string; alt: string}
  | {kind: 'icon'; name: LucideName}
  | {kind: 'mark'};

// label -> declared relPath under assets/ (verbatim key into the assets prop).
// The operator drops the confirmed-PD files; provenance lives in assets/CREDITS.json.
export const IMAGE_MANIFEST: Record<string, string> = {
  sun: 'assets/sun.jpg',
  moon: 'assets/moon.jpg',
  planet: 'assets/planets.jpg',
  eclipse: 'assets/eclipse.jpg',
  phase: 'assets/phases.jpg',
};

// label -> lucide icon name. MUST be a superset of IMAGE_MANIFEST keys (invariant).
export const ICON_MAP: Record<string, LucideName> = {
  sun: 'sun', moon: 'moon', planet: 'orbit', earth: 'globe', mars: 'circle',
  eclipse: 'circle', phase: 'moon', star: 'star', comet: 'sparkle', meteor: 'sparkle',
  galaxy: 'sparkle', telescope: 'telescope', rocket: 'rocket', satellite: 'satellite',
  cloud: 'cloud', rain: 'droplet', water: 'droplet', ocean: 'waves',
  mountain: 'mountain', tree: 'trees', leaf: 'leaf', clock: 'clock',
  gear: 'cog', light: 'lightbulb', book: 'book-open', brain: 'brain', heart: 'heart',
  mercury: 'circle', venus: 'circle', jupiter: 'circle', saturn: 'orbit',
  neptune: 'circle', uranus: 'circle', pluto: 'circle',
};

/**
 * Resolve a label to its best media representation.
 *
 * @param label  - Display label (e.g. "Sun", "Planets").
 * @param assets - staticFile-resolved map from the renderer (resolveAssets(manifest)).
 *                 Keys are the declared relPaths verbatim ("assets/sun.jpg").
 *                 An image match is only emitted when assets[relPath] is truthy —
 *                 fail-closed: absent install → falls through to icon/mark.
 */
export function resolveMedia(label: string, assets: Record<string, string>): MediaResolution {
  const k = label.trim().toLowerCase();
  for (const c of candidates(k)) {
    const rel = IMAGE_MANIFEST[c];
    if (rel && assets[rel]) return {kind: 'image', src: assets[rel], alt: label};
  }
  const name = iconNameFor(label);
  if (name) return {kind: 'icon', name};
  return {kind: 'mark'};
}

/** Icon-layer-only resolve: the lucide name for a label, or null. Used for the LIST
 *  row of an image item (which shows a small icon, never the big image). The
 *  imageManifest ⊆ iconMap invariant guarantees this is non-null for every image
 *  label, so an image row never falls to a blank mark. */
export function iconNameFor(label: string): LucideName | null {
  const k = label.trim().toLowerCase();
  for (const c of candidates(k)) {
    if (ICON_MAP[c]) return ICON_MAP[c];
  }
  return null;
}

/** The designed FLOOR grapheme for an item with no image and no icon: the first
 *  letter-or-digit, uppercased, iterating by code point so a leading symbol/space is
 *  skipped and non-Latin scripts return their first char. Returns null when no
 *  character is representable (empty/whitespace/punctuation-only) → the caller falls
 *  back to a clean glyph. Pure; never throws, never yields a blank badge. */
export function monogram(label: string): string | null {
  for (const ch of label.trim()) {            // for..of iterates Unicode code points
    if (/[\p{L}\p{N}]/u.test(ch)) return ch.toLocaleUpperCase();
  }
  return null;
}

/** kebab LucideName -> PascalCase key in lucide-react's `icons` registry. Lives here
 *  (pure) so both LucideGlyph and the lucide-registry test use the SAME mapping. */
export function toPascal(name: string): string {
  return name.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}
