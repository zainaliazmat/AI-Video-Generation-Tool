import React from 'react';
import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';
import type {TemplateProps} from '../sdk';
import type {HookData} from './schema';

/**
 * `hook` — the opening title card. Big heading + optional accent subtitle, with
 * a quick rise-and-fade-in. Styled entirely from theme tokens (no hardcoded
 * colors/fonts), so the same template re-themes for free.
 *
 * Inter glyphs are loaded globally by the Captions layer in a full video; a
 * system fallback covers the standalone gallery preview until step 5 adds
 * per-template font loading.
 */
const Component: React.FC<TemplateProps<HookData>> = ({data, theme}) => {
  const frame = useCurrentFrame();
  const enter = interpolate(frame, [0, 12], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const y = interpolate(enter, [0, 1], [48, 0]);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.palette.background,
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 96px',
      }}
    >
      <div style={{transform: `translateY(${y}px)`, opacity: enter, textAlign: 'center'}}>
        <div
          style={{
            fontFamily: `${theme.fonts.heading}, system-ui, sans-serif`,
            fontWeight: 800,
            fontSize: 128,
            lineHeight: 1.04,
            letterSpacing: '-0.03em',
            color: theme.palette.foreground,
          }}
        >
          {data.title}
        </div>
        <div
          style={{
            margin: '40px auto 0',
            width: 140,
            height: 10,
            borderRadius: 999,
            backgroundColor: theme.palette.accent,
            transform: `scaleX(${enter})`,
          }}
        />
        {data.subtitle ? (
          <div
            style={{
              marginTop: 36,
              fontFamily: `${theme.fonts.body}, system-ui, sans-serif`,
              fontWeight: 600,
              fontSize: 46,
              color: theme.palette.muted,
            }}
          >
            {data.subtitle}
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};

export default Component;
