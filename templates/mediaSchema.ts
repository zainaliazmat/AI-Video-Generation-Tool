/**
 * Zod mirror of the Python `Media` model (backend/schema.py) and the TS
 * `Media` interface (remotion/src/schema.ts).
 *
 * This is the SINGLE SOURCE OF TRUTH for validating `backgroundClip` props on
 * hero templates (hook / stat / outro) — PRD §6.2, Studio v3 M4.
 *
 * Shape is kept VERBATIM to the canonical models on both sides:
 *   - Python KenBurns has from_/alias="from", to, originX, originY
 *   - extra="forbid" / .strict() → additionalProperties:false
 *   - kenBurns is nullable-optional (Optional[KenBurns] = None)
 *   - loop is optional with a default of false
 */
import {z} from 'zod';

export const kenBurnsSchema = z
  .object({
    from: z.number(),
    to: z.number(),
    originX: z.number(),
    originY: z.number(),
  })
  .strict();

export const mediaSchema = z
  .object({
    type: z.enum(['video', 'image']),
    src: z.string(),
    fit: z.enum(['cover', 'contain']).default('cover'),
    kenBurns: kenBurnsSchema.nullable().optional(),
    loop: z.boolean().default(false),
  })
  .strict();

export type MediaData = z.infer<typeof mediaSchema>;
