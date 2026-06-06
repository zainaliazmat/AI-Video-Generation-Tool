/**
 * Template SDK — the stable contract every template plugin builds against.
 *
 * A template plugin is a self-contained folder:
 *   templates/<id>/
 *     manifest.json   — the language-neutral contract (read by backend + renderer)
 *     schema.ts       — zod input schema (single source of truth for props)
 *     Component.tsx   — the Remotion component, receiving TemplateProps<Data>
 *     sample.preview.mp4 / .poster.jpg — auto-generated from sampleProps
 *
 * This SDK is intentionally framework-light so templates can later ship as
 * installable npm packages and, eventually, install per-tenant at runtime — all
 * against this same contract, with no rewrite (see phase-2 prompt §7).
 *
 * NOTE: `Theme` is imported from the spec schema today. When this package is
 * extracted to a standalone npm package, `Theme`/`CaptionStyle` should move to a
 * shared contract package and both the spec and this SDK import from there.
 */
import type {Theme} from '../remotion/src/schema';

export type {Theme};

/** Template slots. A spec references templates by the slot appropriate to each
 * position (a `transition` cannot go where a `scene` goes). MUST match
 * `TemplateKind` in backend/manifest.py. */
export type TemplateKind =
  | 'hook'
  | 'scene'
  | 'stat'
  | 'lower-third'
  | 'transition'
  | 'overlay'
  | 'outro';

export interface DurationFrames {
  min: number;
  max: number;
}

/** The manifest envelope. MUST stay in lockstep with backend/manifest.py. */
export interface Manifest {
  id: string;
  name: string;
  version: string;
  author: string;
  apiVersion: string;
  kind: TemplateKind;
  /** JSON Schema for this template's props, generated from its zod schema. */
  inputSchema: Record<string, unknown>;
  /** example props used to auto-render the gallery preview */
  sampleProps: Record<string, unknown>;
  durationFrames: DurationFrames;
}

/** staticFile-resolved absolute paths for any media a template references. */
export type ResolvedAssets = Record<string, string>;

/** The stable props object every template component receives. Templates MUST
 * style from `theme` tokens only (no hardcoded colors/fonts) and animate with
 * useCurrentFrame() within timing.durationInFrames. */
export interface TemplateProps<Data = Record<string, unknown>> {
  /** validated against the template's inputSchema */
  data: Data;
  /** resolved palette, fonts, transition style, caption style */
  theme: Theme;
  timing: {fps: number; durationInFrames: number};
  /** staticFile-resolved paths for any media the template needs */
  assets: ResolvedAssets;
}
