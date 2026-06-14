/**
 * HeroBackdrop — the §6.2 layering stack for hero cards (hook / stat / outro).
 *
 * Bottom → top:
 *   1. Clip layer      (only when `clip` present): video or image with kenBurns
 *   2. Scrim layer     (only when `clip` present): flat dark overlay for contrast
 *   3. Gradient layer  (always): the palette-driven radial spotlight / glow
 *   4. Children        (the text content)
 *
 * No-clip mode is STRUCTURALLY IDENTICAL to today's inline background: the
 * gradient AbsoluteFill carries no `opacity` override, so the output is
 * byte-identical to calling heroBackground() inline.
 *
 * With-clip mode: the gradient string is NEVER modified (no-fork rule for
 * heroBackground.ts). Instead, a layer-level `opacity` on the gradient
 * AbsoluteFill lets the clip show through while keeping the spotlight glow.
 *
 * The transform for kenBurns ALWAYS lives on the wrapper AbsoluteFill, never
 * on the <OffthreadVideo> / <Img> element — this is the hard-won scene template
 * rule, mirrored exactly here.
 */
import React from 'react';
import {AbsoluteFill, Img, OffthreadVideo, Video, interpolate, staticFile} from 'remotion';
import type {Palette} from '../remotion/src/schema';
import type {MediaData} from './mediaSchema';
import {
  SCRIM_ALPHA,
  GRADIENT_OPACITY_WITH_CLIP,
  heroBackdropGradientString,
} from './heroBackdropUtils';

// Re-export for consumers that import from HeroBackdrop
export {SCRIM_ALPHA, GRADIENT_OPACITY_WITH_CLIP, heroBackdropGradientString};

interface HeroBackdropProps {
  /** Optional background clip (video or image). Absent = today's opaque gradient card. */
  clip?: MediaData;
  palette: Palette;
  frame: number;
  /** Total scene duration in frames — used to animate kenBurns over the full scene. */
  durationInFrames: number;
  /** Extra styles forwarded to the outer AbsoluteFill (padding, alignment, etc.). */
  containerStyle?: React.CSSProperties;
  children?: React.ReactNode;
}

const CLAMP = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;

const HeroBackdrop: React.FC<HeroBackdropProps> = ({
  clip,
  palette,
  frame,
  durationInFrames,
  containerStyle,
  children,
}) => {
  const gradientString = heroBackdropGradientString(palette, frame);

  // --- Clip layer (only when clip is present) ---
  let clipLayer: React.ReactNode = null;
  if (clip) {
    const kb = clip.kenBurns;
    const scale = kb
      ? interpolate(frame, [0, Math.max(1, durationInFrames - 1)], [kb.from, kb.to], CLAMP)
      : 1;
    const transformOrigin = kb
      ? `${kb.originX * 100}% ${kb.originY * 100}%`
      : '50% 50%';

    clipLayer = (
      // Transform lives on the WRAPPER, never on the media element.
      <AbsoluteFill
        style={{
          transform: `scale(${scale})`,
          transformOrigin,
          overflow: 'hidden',
        }}
      >
        <AbsoluteFill
          style={{
            transform: clip.fit === 'cover' ? 'scale(1.015)' : undefined,
          }}
        >
          {clip.type === 'video' ? (
            clip.loop ? (
              <Video
                src={staticFile(clip.src)}
                muted
                loop
                style={{width: '100%', height: '100%', objectFit: clip.fit}}
              />
            ) : (
              <OffthreadVideo
                src={staticFile(clip.src)}
                muted
                style={{width: '100%', height: '100%', objectFit: clip.fit}}
              />
            )
          ) : (
            <Img
              src={staticFile(clip.src)}
              style={{width: '100%', height: '100%', objectFit: clip.fit}}
            />
          )}
        </AbsoluteFill>
      </AbsoluteFill>
    );
  }

  // --- Gradient layer ---
  // No-clip: no opacity prop → full-opacity gradient, structurally identical to today.
  // With-clip: opacity = GRADIENT_OPACITY_WITH_CLIP so the clip shows through.
  const gradientLayerStyle: React.CSSProperties = clip
    ? {backgroundImage: gradientString, opacity: GRADIENT_OPACITY_WITH_CLIP}
    : {backgroundImage: gradientString};

  return (
    <AbsoluteFill
      style={{
        backgroundColor: palette.background,
        ...containerStyle,
      }}
    >
      {/* 1. Clip layer */}
      {clipLayer}

      {/* 2. Scrim (dark overlay for contrast) — only with a clip */}
      {clip ? (
        <AbsoluteFill
          style={{backgroundColor: `rgba(0,0,0,${SCRIM_ALPHA})`}}
        />
      ) : null}

      {/* 3. Gradient / glow layer — always present */}
      <AbsoluteFill style={gradientLayerStyle} />

      {/* 4. Text content */}
      {children}
    </AbsoluteFill>
  );
};

export default HeroBackdrop;
