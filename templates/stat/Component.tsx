import React from 'react';
import {AbsoluteFill, Easing, interpolate, useCurrentFrame} from 'remotion';
import type {TemplateProps} from '../sdk';
import type {StatData} from './schema';
import {heroBackground} from '../heroBackground';
import {parseCountUp, formatCount} from '../countUp';

/**
 * `stat` — a single oversized value (in the theme accent) with a label beneath.
 * The value pops in with an overshoot and, when the value is a clean leading
 * integer, counts UP to it (the suffix/unit stays static; ranges, decimals, and
 * scientific notation fall back to a static value). Icon and label fade in just
 * after. Everything is theme-driven.
 */

// Fit the value to the frame width: long values (e.g. "37,700 gigatonnes") scale
// DOWN so they never clip; short values (e.g. "5") scale UP to fill. Sized on the
// FINAL value so the count-up never reflows (intermediate counts are never wider).
function valueFontSize(text: string): number {
  const fit = 880 / (Math.max(text.length, 1) * 0.65); // ≈ usable width / (chars × bold-glyph ratio)
  return Math.max(64, Math.min(260, Math.round(fit)));
}

const CLAMP = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;
const COUNT_FRAMES = 30; // count-up settles by here, then shows the exact value

const Component: React.FC<TemplateProps<StatData>> = ({data, theme}) => {
  const frame = useCurrentFrame();
  const pop = interpolate(frame, [0, 14], [0.6, 1], {
    ...CLAMP,
    easing: Easing.out(Easing.back(1.7)),
  });
  const iconFade = interpolate(frame, [0, 10], [0, 1], CLAMP);
  const labelFade = interpolate(frame, [6, 18], [0, 1], CLAMP);

  // Count-up only for a clean leading integer; otherwise render the value as-is.
  const countUp = parseCountUp(data.value);
  const display = countUp
    ? formatCount(
        Math.floor(
          interpolate(frame, [0, COUNT_FRAMES], [0, countUp.target], {
            ...CLAMP,
            easing: Easing.out(Easing.cubic),
          }),
        ),
        countUp.useCommas,
      ) + countUp.suffix
    : data.value;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.palette.background,
        backgroundImage: heroBackground(theme.palette),
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 80px',
        textAlign: 'center',
      }}
    >
      {data.icon ? (
        <div style={{fontSize: 96, lineHeight: 1, marginBottom: 24, opacity: iconFade}}>
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
        {display}
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
          opacity: labelFade,
          transform: `translateY(${interpolate(labelFade, [0, 1], [16, 0])}px)`,
        }}
      >
        {data.label}
      </div>
    </AbsoluteFill>
  );
};

export default Component;
