/**
 * Input data for the `bold-stat` template.
 *
 * A big number/value (`value`) with a count-up animation, and a descriptive
 * label (`label`) beneath it.
 *
 * zod is the SINGLE SOURCE OF TRUTH: gen-manifests exports this to the
 * manifest's `inputSchema` (JSON Schema). `.strict()` → additionalProperties:false.
 */
import {z} from 'zod';

export const schema = z
  .object({
    value: z.string(),
    label: z.string(),
  })
  .strict();

export type BoldStatData = z.infer<typeof schema>;
