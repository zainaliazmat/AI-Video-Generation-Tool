import {describe, expect, it} from 'vitest';
import {wordRevealState, HOOK_DIM} from './hook-reveal';

const T = {startFrame: 10, endFrame: 20};

describe('wordRevealState — opacity reveal', () => {
  it('sits at the dim floor well before the word', () => {
    expect(wordRevealState(0, T).opacity).toBe(HOOK_DIM);
  });
  it('reaches full opacity by the time the word is spoken', () => {
    expect(wordRevealState(20, T).opacity).toBe(1);
  });
  it('stays full after the word (spoken words do not re-dim)', () => {
    expect(wordRevealState(40, T).opacity).toBe(1);
  });
});

describe('wordRevealState — active (the gate invariant)', () => {
  it('is active iff the half-open interval [start,end) contains the frame', () => {
    expect(wordRevealState(9, T).isActive).toBe(false);
    expect(wordRevealState(10, T).isActive).toBe(true);
    expect(wordRevealState(19, T).isActive).toBe(true);
    expect(wordRevealState(20, T).isActive).toBe(false); // end is exclusive
  });
});

describe('wordRevealState — accent + scale', () => {
  it('peaks during the interval and is zero far outside it', () => {
    expect(wordRevealState(15, T).accent).toBe(1);
    expect(wordRevealState(15, T).scale).toBeGreaterThan(1);
    expect(wordRevealState(0, T).accent).toBe(0);
    expect(wordRevealState(0, T).scale).toBe(1);
    expect(wordRevealState(100, T).accent).toBe(0);
  });
});
