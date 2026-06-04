import React from 'react';
import {
  AbsoluteFill,
  Img,
  OffthreadVideo,
  interpolate,
  staticFile,
  useCurrentFrame,
} from 'remotion';
import type {Media} from './schema';

/**
 * One scene's footage with a slow Ken Burns zoom/pan.
 *
 * Rendered INSIDE <Sequence from={startFrame} durationInFrames={dur}>, so
 * useCurrentFrame() here is LOCAL (0 .. dur-1) — interpolate over that range.
 *
 * The Ken Burns transform lives on a WRAPPER AbsoluteFill, never on
 * <OffthreadVideo> directly (transforms on the video element are unreliable in
 * the off-thread render path). A constant 1.5% overscale on the inner layer for
 * "cover" hides sub-pixel edge cracks when the outer scale dips to ~1.0.
 */
export const Scene: React.FC<{
  media: Media;
  durationInFrames: number;
}> = ({media, durationInFrames}) => {
  const frame = useCurrentFrame();
  const kb = media.kenBurns;

  const scale = kb
    ? interpolate(
        frame,
        [0, Math.max(1, durationInFrames - 1)],
        [kb.from, kb.to],
        {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'},
      )
    : 1;

  const transformOrigin = kb
    ? `${kb.originX * 100}% ${kb.originY * 100}%`
    : '50% 50%';

  return (
    <AbsoluteFill
      style={{
        backgroundColor: 'black',
        transform: `scale(${scale})`,
        transformOrigin,
        overflow: 'hidden',
      }}
    >
      <AbsoluteFill
        style={{
          transform: media.fit === 'cover' ? 'scale(1.015)' : undefined,
        }}
      >
        {media.type === 'video' ? (
          <OffthreadVideo
            src={staticFile(media.src)}
            muted
            style={{width: '100%', height: '100%', objectFit: media.fit}}
          />
        ) : (
          <Img
            src={staticFile(media.src)}
            style={{width: '100%', height: '100%', objectFit: media.fit}}
          />
        )}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
