import React from 'react';
import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';
import type {TemplateProps} from '../sdk';
import type {OutroData} from './schema';

/**
 * `outro` — the closing card. Title plus an optional accent CTA pill, fading up
 * on entry. Theme-driven throughout.
 */
const Component: React.FC<TemplateProps<OutroData>> = ({data, theme}) => {
  const frame = useCurrentFrame();
  const enter = interpolate(frame, [0, 14], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const y = interpolate(enter, [0, 1], [40, 0]);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.palette.background,
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 96px',
        textAlign: 'center',
      }}
    >
      <div style={{transform: `translateY(${y}px)`, opacity: enter}}>
        <div
          style={{
            fontFamily: `${theme.fonts.heading}, system-ui, sans-serif`,
            fontWeight: 800,
            fontSize: 104,
            lineHeight: 1.06,
            letterSpacing: '-0.03em',
            color: theme.palette.foreground,
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
            }}
          >
            {data.cta}
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};

export default Component;
