/**
 * Input data for the `overlay` template — an `overlay`-kind layer composited on
 * top of the scenes (the first consumer of spec `layers[]`).
 * Plain TS this phase; step 6 swaps in zod + generated manifest inputSchema.
 */
export interface OverlayData {
  text: string;
}
