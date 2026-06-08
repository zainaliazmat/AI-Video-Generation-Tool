/**
 * Count-up parsing for the `stat` hero card. Stat values vary wildly ("82",
 * "93 billion", "37,700", "60+ feet", but also "14-17 feet", "73.5 km/s/Mpc",
 * "1.5×10^34"). A count-up only makes sense for a clean LEADING INTEGER; the rest
 * of the string (a unit/word/"+") is a static suffix. Ranges, decimals, and
 * scientific notation fall back to `null` — the card shows the value statically
 * (entrance-only), the same fails-closed discipline used elsewhere.
 *
 * Pure functions, unit-tested without a DOM; the stat component drives the
 * frame-by-frame interpolation and formats with `formatCount`.
 */
export interface CountUp {
  /** the integer to count up to */
  target: number;
  /** text shown verbatim after the number (e.g. " billion", "+ feet") */
  suffix: string;
  /** whether the source grouped thousands with commas (mirror it back) */
  useCommas: boolean;
}

// Leading integer, optionally thousands-grouped ("37,700") — comma form first.
const LEADING_INT = /^(\d{1,3}(?:,\d{3})+|\d+)/;

export function parseCountUp(value: string): CountUp | null {
  const m = LEADING_INT.exec(value);
  if (!m) return null;
  const rest = value.slice(m[0].length);
  // Decimal / scientific ("73.5 …", "1.5×10^34") — not an integer to count.
  if (/^\./.test(rest)) return null;
  // Range ("14-17 feet") — animating only the lower bound would mislead.
  if (/^[-–—]\d/.test(rest)) return null;
  return {
    target: parseInt(m[0].replace(/,/g, ''), 10),
    suffix: rest,
    useCommas: m[0].includes(','),
  };
}

/** Render an integer, optionally with thousands separators (locale-independent). */
export function formatCount(n: number, useCommas: boolean): string {
  const s = Math.trunc(n).toString();
  return useCommas ? s.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : s;
}
