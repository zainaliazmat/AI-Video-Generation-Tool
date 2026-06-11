import {describe, expect, it} from 'vitest';
import {resolveCaptionFontSize} from './caption-size';

// CaptionStyle.size migration (the deferred ruling, closed): size is OPTIONAL.
// Absent/null -> the exact legacy derivation Math.round(height * 0.045), so every
// existing spec renders byte-identically. Present -> absolute px, the honest
// target of the Assemble gate's "make the captions bigger".
describe('resolveCaptionFontSize', () => {
  it('falls back to the legacy height derivation when size is absent', () => {
    expect(resolveCaptionFontSize(undefined, 1920)).toBe(Math.round(1920 * 0.045)); // 86
    expect(resolveCaptionFontSize(null, 1920)).toBe(86);
    expect(resolveCaptionFontSize(undefined, 1280)).toBe(Math.round(1280 * 0.045));
  });

  it('uses the explicit px size when present', () => {
    expect(resolveCaptionFontSize(56, 1920)).toBe(56);
    expect(resolveCaptionFontSize(120, 1080)).toBe(120);
  });

  it('ignores non-positive sizes (fail-safe to the derivation, never 0px text)', () => {
    expect(resolveCaptionFontSize(0, 1920)).toBe(86);
    expect(resolveCaptionFontSize(-5, 1920)).toBe(86);
  });
});
