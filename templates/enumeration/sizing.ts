/**
 * Auto-fit sizing for the enumeration list band by item count: larger for fewer items,
 * shrinking for more so all items fit the supplied band height WITHOUT wrapping.
 * Pure + clamped → unit-tested. The monotonic + no-overflow shape is the contract.
 */

// The hero owns the top fraction; the running list gets the remainder minus padding.
// ONE source of truth so the Component's sizing call and the sizing test never diverge.
export const HERO_BAND_FRACTION = 0.58;
const LIST_VPAD = 120; // vertical padding inside the list band (top+bottom)

export function listBandHeight(totalHeight = 1920): number {
  return Math.round(totalHeight * (1 - HERO_BAND_FRACTION)) - LIST_VPAD;
}

export interface EnumerationSizing {
  iconSize: number;
  labelSize: number;
  rowGap: number;
}

export function enumerationSizing(itemCount: number, bandHeight: number): EnumerationSizing {
  const n = Math.max(2, Math.min(6, itemCount));
  // Budget the band across n rows + (n-1) gaps; gap is ~0.4 of a row.
  const perRow = bandHeight / (n + (n - 1) * 0.4);
  const iconSize = Math.floor(Math.min(perRow, 200)); // cap so few items don't balloon
  return {
    iconSize,
    labelSize: Math.round(iconSize * 0.52),
    rowGap: Math.round(iconSize * 0.4),
  };
}
