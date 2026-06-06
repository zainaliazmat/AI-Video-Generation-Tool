/**
 * Input data for the `stat` template (a single big number/value callout).
 *
 * zod is the SINGLE SOURCE OF TRUTH (step 6.3): `gen-manifests` exports this to
 * the manifest's `inputSchema` (JSON Schema) for the Python validator. The recipe
 * derives a `stat` from a beat whose data carries both `value` and `label`.
 */
import {z} from 'zod';

export const schema = z
  .object({
    value: z.string(),
    label: z.string(),
    /** optional leading glyph/emoji shown above the value */
    icon: z.string().optional(),
  })
  .strict();

export type StatData = z.infer<typeof schema>;
