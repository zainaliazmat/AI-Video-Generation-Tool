/**
 * Input data for the `kinetic-hook` template.
 *
 * Words of `title` cascade in with staggered rise + fade; an accent underline
 * sweeps beneath. `kicker` (optional) appears above the title as a label.
 *
 * zod is the SINGLE SOURCE OF TRUTH: gen-manifests exports this to the
 * manifest's `inputSchema` (JSON Schema). `.strict()` → additionalProperties:false.
 */
import {z} from 'zod';

export const schema = z
  .object({
    title: z.string(),
    kicker: z.string().optional(),
  })
  .strict();

export type KineticHookData = z.infer<typeof schema>;
