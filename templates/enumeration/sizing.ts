/**
 * Auto-fit sizing for the enumeration column by item count: larger for fewer items
 * (so 2 fills the frame), shrinking for more so 6 fit the 1920px height WITHOUT
 * wrapping. Pure + clamped → unit-tested. Exact px are a starting point tuned on
 * the motion gate; the monotonic + no-overflow shape is the contract.
 */
export interface EnumerationSizing {
  iconSize: number;
  labelSize: number;
  rowGap: number;
}

export function enumerationSizing(itemCount: number): EnumerationSizing {
  const n = Math.max(2, Math.min(6, itemCount));
  return {
    iconSize: Math.round(200 - (n - 2) * 26), // n2:200 … n6:96
    labelSize: Math.round(104 - (n - 2) * 11), // n2:104 … n6:60
    rowGap: Math.round(112 - (n - 2) * 17), // n2:112 … n6:44
  };
}
