/**
 * Input data for the `stat` template (a single big number/value callout).
 * Plain TS this phase; step 6 swaps in zod + generated manifest inputSchema.
 */
export interface StatData {
  value: string;
  label: string;
  /** optional leading glyph/emoji shown above the value */
  icon?: string;
}
