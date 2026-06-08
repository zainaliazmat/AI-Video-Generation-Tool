import {describe, expect, it} from 'vitest';
import {
  splitDisplayWords,
  alignHookWords,
  hookWordTimingsForScene,
} from './word-alignment';
import type {Caption} from './schema';

const cap = (text: string, startFrame: number, endFrame: number): Caption => ({
  text,
  startFrame,
  endFrame,
});

describe('splitDisplayWords', () => {
  it('splits on whitespace and drops empty tokens', () => {
    expect(splitDisplayWords('  Could   a  machine? ')).toEqual([
      'Could',
      'a',
      'machine?',
    ]);
  });
  it('returns [] for blank input', () => {
    expect(splitDisplayWords('   ')).toEqual([]);
  });
});

describe('alignHookWords — happy path', () => {
  it('one caption per word maps each word to its caption span', () => {
    const captions = [cap('Why', 0, 6), cap('the', 6, 10), cap('ocean', 10, 20)];
    expect(alignHookWords('Why the ocean', captions, 0, 30)).toEqual([
      {word: 'Why', startFrame: 0, endFrame: 6},
      {word: 'the', startFrame: 6, endFrame: 10},
      {word: 'ocean', startFrame: 10, endFrame: 20},
    ]);
  });
});

describe('alignHookWords — whisper fragmentation (display word spans many captions)', () => {
  it('re-glues "2,000-year-old" split across 3 captions into one span', () => {
    const captions = [
      cap('Could', 0, 6),
      cap('a', 6, 8),
      cap('2,000', 8, 18),
      cap('-year', 18, 22),
      cap('-old', 22, 26),
      cap('machine', 26, 34),
    ];
    expect(
      alignHookWords('Could a 2,000-year-old machine', captions, 0, 60),
    ).toEqual([
      {word: 'Could', startFrame: 0, endFrame: 6},
      {word: 'a', startFrame: 6, endFrame: 8},
      {word: '2,000-year-old', startFrame: 8, endFrame: 26},
      {word: 'machine', startFrame: 26, endFrame: 34},
    ]);
  });
});

describe('alignHookWords — whisper merge (one caption spans many display words)', () => {
  it('two display words sharing one merged caption share its span', () => {
    const captions = [cap('predicteclipses', 10, 30)];
    expect(alignHookWords('predict eclipses', captions, 0, 60)).toEqual([
      {word: 'predict', startFrame: 10, endFrame: 30},
      {word: 'eclipses', startFrame: 10, endFrame: 30},
    ]);
  });
});

describe('alignHookWords — count mismatch reconciles by characters', () => {
  it('aligns when caption count (4) != display word count (3)', () => {
    const captions = [
      cap('A', 0, 4),
      cap('2,000', 4, 14),
      cap('-year', 14, 18),
      cap('-old', 18, 22),
    ];
    expect(alignHookWords('A 2,000-year-old robot', captions, 0, 60)).toBeNull();
  });
});

describe('alignHookWords — next-scene bleed', () => {
  it('ignores trailing caption that belongs to the next scene ("It"-bleed)', () => {
    const captions = [
      cap('eclipses?', 10, 26),
      cap('It', 28, 40),
    ];
    expect(alignHookWords('eclipses?', captions, 0, 30)).toEqual([
      {word: 'eclipses?', startFrame: 10, endFrame: 26},
    ]);
  });
});

describe('alignHookWords — normalization', () => {
  it('matches across apostrophe/quote/em-dash/case differences', () => {
    const captions = [
      cap("IT'S", 0, 6),
      cap('a-go', 6, 14),
    ];
    expect(alignHookWords("It’s a—go", captions, 0, 30)).toEqual([
      {word: "It’s", startFrame: 0, endFrame: 6},
      {word: "a—go", startFrame: 6, endFrame: 14},
    ]);
  });
});

describe('alignHookWords — fail-closed cases', () => {
  it('returns null when the text never reconciles', () => {
    const captions = [cap('totally', 0, 6), cap('different', 6, 12)];
    expect(alignHookWords('Why the ocean', captions, 0, 30)).toBeNull();
  });
  it('returns null for empty title', () => {
    expect(alignHookWords('', [cap('x', 0, 6)], 0, 30)).toBeNull();
  });
  it('returns null when no captions overlap the scene span', () => {
    const captions = [cap('Why', 100, 106)];
    expect(alignHookWords('Why', captions, 0, 30)).toBeNull();
  });
  it('returns null when captions run out before the display is consumed', () => {
    const captions = [cap('Why', 0, 6)];
    expect(alignHookWords('Why the ocean', captions, 0, 30)).toBeNull();
  });
  it('returns null when overlapping captions are all punctuation (empty char stream)', () => {
    const captions = [cap('...', 0, 6), cap('—', 6, 12)];
    expect(alignHookWords('Why the ocean', captions, 0, 30)).toBeNull();
  });
});

describe('alignHookWords — punctuation-only display token', () => {
  it('emits a zero-width timing for a token with no alphanumerics', () => {
    const captions = [cap('A', 0, 6), cap('B', 6, 12)];
    expect(alignHookWords('A — B', captions, 0, 30)).toEqual([
      {word: 'A', startFrame: 0, endFrame: 6},
      {word: '—', startFrame: 6, endFrame: 6},
      {word: 'B', startFrame: 6, endFrame: 12},
    ]);
  });
});

describe('hookWordTimingsForScene — scene-relative conversion', () => {
  it('subtracts the scene start frame', () => {
    const captions = [cap('Why', 100, 106), cap('now', 106, 112)];
    expect(hookWordTimingsForScene('Why now', captions, 100, 20)).toEqual([
      {word: 'Why', startFrame: 0, endFrame: 6},
      {word: 'now', startFrame: 6, endFrame: 12},
    ]);
  });
  it('propagates null (fail-closed) from the aligner', () => {
    expect(hookWordTimingsForScene('Why', [], 0, 20)).toBeNull();
  });
});
