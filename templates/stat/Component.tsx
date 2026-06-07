import React from 'react';
import {AbsoluteFill, Easing, interpolate, useCurrentFrame} from 'remotion';
import type {TemplateProps} from '../sdk';
import type {StatData} from './schema';
import {heroBackground, HERO_BACKGROUND_DEFAULT} from '../heroBackground';

/**
 * `stat` — a single oversized value (in the theme accent) with a label beneath.
 * The value pops in with an overshoot; everything is theme-driven.
 */

// Fit the value to the frame width: long values (e.g. "37,700 gigatonnes") scale
// DOWN so they never clip; short values (e.g. "5") scale UP to fill. One move for
// both the overflow and the single-digit-too-small cases.
function valueFontSize(text: string): number {
  const fit = 880 / (Math.max(text.length, 1) * 0.65); // ≈ usable width / (chars × bold-glyph ratio)
  return Math.max(64, Math.min(260, Math.round(fit)));
}

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
        backgroundImage: heroBackground(theme.palette, HERO_BACKGROUND_DEFAULT),
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
          fontSize: valueFontSize(data.value),
          lineHeight: 0.95,
          letterSpacing: '-0.04em',
          color: theme.palette.accent,
          transform: `scale(${pop})`,
          maxWidth: 920,
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
