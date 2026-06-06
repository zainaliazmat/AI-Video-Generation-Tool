/**
 * Input data for the `overlay` template — an `overlay`-kind layer composited on
 * top of the scenes (the first consumer of spec `layers[]`).
 *
 * zod is the SINGLE SOURCE OF TRUTH (step 6.3): `gen-manifests` exports this to
 * the manifest's `inputSchema` (JSON Schema) for the Python validator.
 */
import {z} from 'zod';

export const schema = z
  .object({
    text: z.string(),
  })
  .strict();

export type OverlayData = z.infer<typeof schema>;
