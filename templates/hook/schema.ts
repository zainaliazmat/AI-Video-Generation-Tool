/**
 * Input data for the `hook` template (the opening attention-grabber).
 *
 * zod is the SINGLE SOURCE OF TRUTH (step 6.3): `gen-manifests` exports this to
 * the manifest's `inputSchema` (JSON Schema) for the Python validator. `.strict()`
 * → additionalProperties:false. zod is a TYPE-only import in the component
 * (HookData = z.infer), so it never enters the render bundle.
 */
import {z} from 'zod';

export const schema = z
  .object({
    title: z.string(),
    subtitle: z.string().optional(),
  })
  .strict();

export type HookData = z.infer<typeof schema>;
