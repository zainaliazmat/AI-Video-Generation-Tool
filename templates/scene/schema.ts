/**
 * Input data contract for the `scene` template.
 *
 * Authored as a plain TS type THIS phase. Step 6 swaps this for a zod schema
 * that becomes the single source of truth and generates the manifest's
 * `inputSchema` (JSON Schema) — keep manifest.json.inputSchema in sync until then.
 */
export interface SceneData {
  media: {
    type: 'video' | 'image';
    /** path relative to remotion/public/ */
    src: string;
    fit: 'cover' | 'contain';
    kenBurns?: {
      from: number;
      to: number;
      originX: number;
      originY: number;
    } | null;
  };
}
