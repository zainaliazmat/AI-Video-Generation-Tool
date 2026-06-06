import React from 'react';
import {AbsoluteFill, Easing, interpolate, useCurrentFrame} from 'remotion';
import type {TemplateProps} from '../sdk';
import type {StatData} from './schema';

/**
 * `stat` — a single oversized value (in the theme accent) with a label beneath.
 * The value pops in with an overshoot; everything is theme-driven.
 */
const Component: React.FC<TemplateProps<StatData>> = ({data, theme}) => {
  const frame = useCurrentFrame();
  const pop = interpolate(frame, [0, 14], [0.6, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.back(1.7)),
  });
  const fade = interpolate(frame, [0, 10], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.palette.background,
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 80px',
        textAlign: 'center',
      }}
    >
      {data.icon ? (
        <div style={{fontSize: 96, lineHeight: 1, marginBottom: 24, opacity: fade}}>
          {data.icon}
        </div>
      ) : null}
      <div
        style={{
          fontFamily: `${theme.fonts.heading}, system-ui, sans-serif`,
          fontWeight: 800,
          fontSize: 240,
          lineHeight: 0.95,
          letterSpacing: '-0.04em',
          color: theme.palette.accent,
          transform: `scale(${pop})`,
        }}
      >
        {data.value}
      </div>
      <div
        style={{
          marginTop: 28,
          maxWidth: 720,
          fontFamily: `${theme.fonts.body}, system-ui, sans-serif`,
          fontWeight: 600,
          fontSize: 52,
          lineHeight: 1.2,
          color: theme.palette.foreground,
          opacity: fade,
        }}
      >
        {data.label}
      </div>
    </AbsoluteFill>
  );
};

export default Component;
