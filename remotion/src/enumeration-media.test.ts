import {describe, it, expect} from 'vitest';
import {resolveMedia, iconNameFor, IMAGE_MANIFEST, ICON_MAP, monogram} from '../../templates/enumeration/media';

describe('resolveMedia cascade', () => {
  it('resolves a curated image label to an image (with alt = original label)', () => {
    const r = resolveMedia('Sun');
    expect(r.kind).toBe('image');
    if (r.kind === 'image') {
      expect(r.src).toBe(IMAGE_MANIFEST['sun']);
      expect(r.alt).toBe('Sun');
    }
  });
  it('folds plurals to the singular image key (Planets -> planet)', () => {
    const r = resolveMedia('Planets');
    expect(r.kind).toBe('image');
    if (r.kind === 'image') expect(r.src).toBe(IMAGE_MANIFEST['planet']);
  });
  it('falls to a lucide icon for an icon-only label (Telescope)', () => {
    const r = resolveMedia('Telescope');
    expect(r).toEqual({kind: 'icon', name: 'telescope'});
  });
  it('falls to a neutral mark for an unknown label', () => {
    const r = resolveMedia('Xyzzy');
    expect(r).toEqual({kind: 'mark'});
  });
  it('INVARIANT: every image-manifest key has an icon-map key (image rows never show a blank mark)', () => {
    const missing = Object.keys(IMAGE_MANIFEST).filter((k) => !(k in ICON_MAP));
    expect(missing).toEqual([]);
  });
});

describe('iconNameFor (icon-layer-only resolve, for list rows of image items)', () => {
  it('returns the icon name for an image label (the list row of a hero image)', () => {
    // Sun resolves to an image in resolveMedia, but its LIST row needs the icon name.
    expect(iconNameFor('Sun')).toBe('sun');
    expect(iconNameFor('Planets')).toBe('orbit'); // plural-folds to planet -> orbit
  });
  it('returns null for a label with no icon-map entry', () => {
    expect(iconNameFor('Xyzzy')).toBeNull();
  });
});

describe('ICON_MAP planet/common-term coverage (no bare dot for the obvious set)', () => {
  it('resolves the inner/outer planets to an icon, not a mark', () => {
    for (const p of ['Mercury', 'Venus', 'Jupiter', 'Saturn', 'Neptune', 'Uranus']) {
      expect(resolveMedia(p).kind).toBe('icon');
    }
  });
});

describe('monogram (the designed floor grapheme rule — never a blank badge)', () => {
  it('uppercases the first letter of a normal label', () => {
    expect(monogram('Mercury')).toBe('M');
    expect(monogram('venus')).toBe('V');
  });
  it('skips a leading symbol/space to the first letter-or-digit', () => {
    expect(monogram('  #hashtag')).toBe('H');
    expect(monogram('  3-body problem')).toBe('3');   // a leading digit is representable
  });
  it('uses the first representable char of a non-Latin script', () => {
    expect(monogram('日本')).toBe('日');               // CJK: no case, returned as-is
  });
  it('returns null when there is no representable character (→ circle fallback)', () => {
    expect(monogram('')).toBeNull();
    expect(monogram('   ')).toBeNull();
    expect(monogram('!!!')).toBeNull();
  });
});
