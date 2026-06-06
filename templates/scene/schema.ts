/**
 * Input data contract for the `scene` template (footage + Ken Burns).
 *
 * zod is the SINGLE SOURCE OF TRUTH (step 6.3): `gen-manifests` exports this to
 * the manifest's `inputSchema` (JSON Schema) for the Python validator. zod is a
 * TYPE-only import in the component (SceneData = z.infer), so it never enters the
 * render bundle.
 */
import {z} from 'zod';

const kenBurns = z
  .object({
    from: z.number(),
    to: z.number(),
    originX: z.number(),
    originY: z.number(),
  })
  .strict();

export const schema = z
  .object({
    media: z
      .object({
        type: z.enum(['video', 'image']),
        /** path relative to remotion/public/ */
        src: z.string(),
        fit: z.enum(['cover', 'contain']),
        kenBurns: kenBurns.nullable().optional(),
        /** clip-length fallback: loop a short clip to fill the scene span (dᵢ+Tᵢ) */
        loop: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

export type SceneData = z.infer<typeof schema>;
