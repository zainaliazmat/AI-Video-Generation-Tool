import {describe, it, expect} from 'vitest';
import {itemTimingsForScene} from './item-timing';
import type {Caption} from './schema';

// build a per-word caption stream: each word spans 10 frames, starting at `base`.
function caps(words: string[], base = 0): Caption[] {
  return words.map((text, i) => ({text, startFrame: base + i * 10, endFrame: base + i * 10 + 9}));
}

const SENT = 'Our solar system has the sun the moon the planets eclipses and phases'.split(' ');

describe('itemTimingsForScene', () => {
  it('resolves the canonical set in order with exact + plural tolerance', () => {
    const r = itemTimingsForScene(['sun', 'moon', 'planets', 'eclipse', 'phases'], caps(SENT), 0, 200);
    expect(r).not.toBeNull();
    expect(r!.map((t) => t.label)).toEqual(['sun', 'moon', 'planets', 'eclipse', 'phases']);
    // scene-relative startFrames strictly increasing
    const f = r!.map((t) => t.startFrame);
    expect(f).toEqual([...f].sort((a, b) => a - b));
    expect(new Set(f).size).toBe(f.length);
    // 'eclipse' label matched the 'eclipses' caption (prefix, both ≥4)
    const eclipsesStart = caps(SENT).find((c) => c.text === 'eclipses')!.startFrame;
    expect(r![3].startFrame).toBe(eclipsesStart);
  });

  it('matches singular label to plural spoken word and skips articles', () => {
    const r = itemTimingsForScene(['planet', 'phase'], caps(['the', 'planets', 'and', 'phases']), 0, 100);
    expect(r).not.toBeNull();
    expect(r!.map((t) => t.label)).toEqual(['planet', 'phase']);
    expect(r!.map((t) => t.startFrame)).toEqual([10, 30]);
  });

  it('matches a multi-word label against consecutive caption words', () => {
    const r = itemTimingsForScene(['solar eclipse'], caps(['a', 'solar', 'eclipse', 'today']), 0, 100);
    expect(r).not.toBeNull();
    expect(r![0].startFrame).toBe(10); // 'solar'
  });

  it('FALSE-POSITIVE GUARD: short label "sun" must NOT match "sunday"', () => {
    expect(itemTimingsForScene(['sun'], caps(['on', 'sunday', 'morning']), 0, 100)).toBeNull();
  });

  it('fails closed (null) when an item is missing', () => {
    expect(itemTimingsForScene(['sun', 'comet'], caps(['the', 'sun', 'rose']), 0, 100)).toBeNull();
  });

  it('fails closed (null) when items are out of spoken order', () => {
    expect(itemTimingsForScene(['moon', 'sun'], caps(['the', 'sun', 'and', 'moon']), 0, 100)).toBeNull();
  });

  it('rebases to scene-relative frames and filters to the span', () => {
    const r = itemTimingsForScene(['sun', 'moon'], caps(['sun', 'moon'], 300), 300, 100);
    expect(r!.map((t) => t.startFrame)).toEqual([0, 10]);
  });

  it('null on empty labels or empty caption span', () => {
    expect(itemTimingsForScene([], caps(['sun']), 0, 100)).toBeNull();
    expect(itemTimingsForScene(['sun'], [], 0, 100)).toBeNull();
  });
});
