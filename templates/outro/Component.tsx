import React from 'react';
import {AbsoluteFill, Easing, interpolate, useCurrentFrame} from 'remotion';
import type {TemplateProps} from '../sdk';
import type {OutroData} from './schema';
import {heroBackground} from '../heroBackground';

/**
 * `outro` — the closing card. The title rises+fades in, then the accent CTA pill
 * pops in just after (a short stagger, not a hard cut). Theme-driven throughout.
 */
const CLAMP = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;

const Component: React.FC<TemplateProps<OutroData>> = ({data, theme}) => {
  const frame = useCurrentFrame();
  const title = interpolate(frame, [0, 14], [0, 1], CLAMP);
  const cta = interpolate(frame, [9, 22], [0, 1], CLAMP);
  // CTA pops in with a slight overshoot, just after the title settles.
  const ctaPop = interpolate(frame, [9, 24], [0.8, 1], {
    ...CLAMP,
    easing: Easing.out(Easing.back(1.7)),
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.palette.background,
        backgroundImage: heroBackground(theme.palette),
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 96px',
        textAlign: 'center',
      }}
    >
      <div
        style={{
          fontFamily: `${theme.fonts.heading}, system-ui, sans-serif`,
          fontWeight: 800,
          fontSize: 104,
          lineHeight: 1.06,
          letterSpacing: '-0.03em',
          color: theme.palette.foreground,
          opacity: title,
          transform: `translateY(${interpolate(title, [0, 1], [36, 0])}px)`,
        }}
      >
        {data.title}
      </div>
      {data.cta ? (
        <div
          style={{
            display: 'inline-block',
            marginTop: 48,
            padding: '24px 56px',
            borderRadius: 999,
            backgroundColor: theme.palette.accent,
            color: theme.palette.background,
            fontFamily: `${theme.fonts.body}, system-ui, sans-serif`,
            fontWeight: 700,
            fontSize: 48,
            opacity: cta,
            transform: `translateY(${interpolate(cta, [0, 1], [24, 0])}px) scale(${ctaPop})`,
          }}
        >
          {data.cta}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

export default Component;
