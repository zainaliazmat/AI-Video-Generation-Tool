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

export interface Scene {
  id: string;
  startFrame: number;
  durationInFrames: number;
  media: Media;
}

export interface Caption {
  text: string;
  startFrame: number;
  endFrame: number;
}

export interface Style {
  captionFontFamily: string;
  captionFontWeight: number;
  captionColor: string;
  /** color of the word currently spoken */
  captionHighlightColor: string;
  captionStrokeColor: string;
  /** 0 = top, 1 = bottom */
  captionPositionY: number;
}

export interface Spec {
  meta: Meta;
  audio: Audio;
  scenes: Scene[];
  captions: Caption[];
  style: Style;
}
