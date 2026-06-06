/**
 * Input data for the `outro` template (closing card / call to action).
 * Plain TS this phase; step 6 swaps in zod + generated manifest inputSchema.
 */
export interface OutroData {
  title: string;
  /** optional call-to-action shown in an accent pill */
  cta?: string;
}
