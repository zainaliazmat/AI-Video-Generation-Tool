/**
 * Input data for the `outro` template (closing card / call to action).
 *
 * zod is the SINGLE SOURCE OF TRUTH (step 6.3): `gen-manifests` exports this to
 * the manifest's `inputSchema` (JSON Schema) for the Python validator.
 */
import {z} from 'zod';
import {mediaSchema} from '../mediaSchema';

export const schema = z
  .object({
    title: z.string(),
    /** optional call-to-action shown in an accent pill */
    cta: z.string().optional(),
    backgroundClip: mediaSchema.optional(),
  })
  .strict();

export type OutroData = z.infer<typeof schema>;
