// CaptionStyle.size resolution (hand-mirrored contract: schema.ts <-> backend/schema.py).
//
// size is OPTIONAL in the contract. Absent/null -> the legacy derivation
// Math.round(height * 0.045) (~86px at 1920), so every spec written before the
// migration renders byte-identically. Present -> absolute px (the Assemble gate's
// "make the captions bigger" finally has a real lever). Non-positive values fall
// back to the derivation — never 0px text from a bad patch.
export const resolveCaptionFontSize = (
  size: number | null | undefined,
  height: number,
): number => {
  if (typeof size === 'number' && size > 0) {
    return Math.round(size);
  }
  return Math.round(height * 0.045);
};
