/**
 * Input data for the `enumeration` template: an enumerable set of short labels
 * the narration names in order, revealed one-by-one in sync with the voiceover.
 *
 * zod is the SINGLE SOURCE OF TRUTH (step 6.3): `gen-manifests` exports this to
 * the manifest's `inputSchema` (JSON Schema) for the Python validator. The recipe
 * derives an `enumeration` from a beat whose `data.items` carries the set (see
 * docs/superpowers/specs/2026-06-08-enumeration-layout-design.md). Icons are NOT
 * in props — the template curates label→glyph itself (design §3.3).
 */
import {z} from 'zod';

export const schema = z
  .object({
    items: z.array(z.string().min(1)).min(2).max(6),
  })
  .strict();

export type EnumerationData = z.infer<typeof schema>;
