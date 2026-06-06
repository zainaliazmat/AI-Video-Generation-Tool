/**
 * TypeScript mirror of the spec.json contract.
 *
 * This is one of the two definitions of the data contract between the backend
 * (Python) and the renderer (Remotion/TS). It MUST stay identical in shape to
 * `backend/schema.py`. All timing is in FRAMES (fps lives in `meta`).
 */

export type MediaType = "video" | "image";
export type Fit = "cover" | "contain";

export interface Meta {
  title: string;
  fps: number;
  width: number;
  height: number;
  durationInFrames: number;
}

export interface Audio {
  /** path relative to remotion/public/ */
  voiceover: string;
  /** path relative to remotion/public/, or null if none */
  music: string | null;
  /** ducked under the voice */
  musicVolumeDb: number;
}

export interface KenBurns {
  from: number;
  to: number;
  originX: number;
  originY: number;
}

export interface Media {
  type: MediaType;
  /** path relative to remotion/public/ */
  src: string;
  fit: Fit;
  kenBurns?: KenBurns | null;
}

/** A transition leading OUT of a scene into the next (references a
 * `transition`-kind template). Ignored on the final scene. */
export interface Transition {
  template: string;
  durationInFrames: number;
  props?: Record<string, unknown>;
}

export interface Scene {
  id: string;
  startFrame: number;
  durationInFrames: number;
  // A template-driven scene carries its content in `templateProps` (validated
  // against the template's inputSchema in a later step). `media` is optional —
  // the `scene` template puts its footage in templateProps; non-media templates
  // (e.g. a stat callout) have neither.
  template?: string;
  templateProps?: Record<string, unknown>;
  media?: Media | null;
  transition?: Transition | null; // transition OUT of this scene
}

export interface Caption {
  text: string;
  startFrame: number;
  endFrame: number;
}

/** An overlay composited on top of the scenes (an `overlay`-kind template).
 * Overlay-only this phase; captions remain a top-level field for now. */
export interface Layer {
  id: string;
  template: string;
  startFrame: number;
  durationInFrames: number;
  props?: Record<string, unknown>;
}

export interface Palette {
  background: string;
  foreground: string;
  accent: string;
  muted: string;
}

export interface Fonts {
  heading: string;
  body: string;
}

export interface CaptionStyle {
  fontFamily: string;
  fontWeight: number;
  color: string;
  /** color of the word currently spoken */
  highlightColor: string;
  strokeColor: string;
  /** 0 = top, 1 = bottom */
  positionY: number;
}

/** Resolved look of a video, separate from templates so any template re-themes
 * without code changes. */
export interface Theme {
  palette: Palette;
  fonts: Fonts;
  /** default transition style name */
  transition: string;
  caption: CaptionStyle;
}

export interface Spec {
  meta: Meta;
  audio: Audio;
  scenes: Scene[];
  captions: Caption[];
  theme: Theme;
  layers?: Layer[];
}
