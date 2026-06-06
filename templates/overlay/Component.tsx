import React from 'react';
import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';
import type {TemplateProps} from '../sdk';
import type {OverlayData} from './schema';

/**
 * `overlay` — a small brand "bug" composited on top of the video for the
 * layer's duration (the first spec `layers[]` consumer). Pinned top-left so it
 * never collides with the bottom caption band. Transparent everywhere else;
 * theme-driven chip.
 */
const Component: React.FC<TemplateProps<OverlayData>> = ({data, theme}) => {
  const frame = useCurrentFrame();
  const fade = interpolate(frame, [0, 10], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill style={{pointerEvents: 'none'}}>
      <div
        style={{
          position: 'absolute',
          top: 56,
          left: 56,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 16,
          padding: '18px 30px',
          borderRadius: 999,
          backgroundColor: theme.palette.background,
          border: `3px solid ${theme.palette.accent}`,
          opacity: fade,
          transform: `translateY(${interpolate(fade, [0, 1], [-12, 0])}px)`,
        }}
      >
        <span
          style={{width: 18, height: 18, borderRadius: 999, backgroundColor: theme.palette.accent}}
        />
        <span
          style={{
            fontFamily: `${theme.fonts.body}, system-ui, sans-serif`,
            fontWeight: 700,
            fontSize: 34,
            color: theme.palette.foreground,
          }}
        >
          {data.text}
        </span>
      </div>
    </AbsoluteFill>
  );
};

export default Component;
