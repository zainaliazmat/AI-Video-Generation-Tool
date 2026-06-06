import React from 'react';
import {
  AbsoluteFill,
  Img,
  OffthreadVideo,
  interpolate,
  staticFile,
  useCurrentFrame,
} from 'remotion';
import type {TemplateProps} from '../sdk';
import type {SceneData} from './schema';

/**
 * The workhorse `scene` template — one footage clip with a slow Ken Burns
 * zoom/pan. Migrated verbatim from the former built-in Scene renderer; core no
 * longer hardcodes it (it resolves through the registry by id).
 *
 * Rendered INSIDE the dispatcher's <Sequence>, so useCurrentFrame() here is
 * LOCAL (0 .. durationInFrames-1) — interpolate the Ken Burns over that range.
 *
 * The transform lives on a WRAPPER AbsoluteFill, never on <OffthreadVideo>
 * directly (transforms on the video element are unreliable in the off-thread
 * render path). A constant 1.5% overscale on the inner layer for "cover" hides
 * sub-pixel edge cracks when the outer scale dips to ~1.0. Background comes from
 * the theme so the template re-themes without code changes.
 */
const Component: React.FC<TemplateProps<SceneData>> = ({data, theme, timing}) => {
  const frame = useCurrentFrame();
  const {media} = data;
  const kb = media.kenBurns;
  const dur = timing.durationInFrames;

  const scale = kb
    ? interpolate(frame, [0, Math.max(1, dur - 1)], [kb.from, kb.to], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      })
    : 1;

  const transformOrigin = kb
    ? `${kb.originX * 100}% ${kb.originY * 100}%`
    : '50% 50%';

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.palette.background,
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

export default Component;
