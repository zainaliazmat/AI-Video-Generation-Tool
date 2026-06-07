import React from 'react';
import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';
import type {TemplateProps} from '../sdk';
import type {HookData} from './schema';
import {heroBackground, HERO_BACKGROUND_DEFAULT} from '../heroBackground';

/**
 * `hook` — the opening attention-grabber. The spoken hook line (`title`) is the
 * HERO: large, high-contrast, and auto-sized so a full sentence fills the frame
 * without overflowing. An optional `subtitle` rides above as a small accent
 * kicker (the video's topic). Rise-and-fade in; fully theme-driven (no hardcoded
 * colors/fonts), so the same template re-themes for free.
 */

// Auto-size the hero line: short punchy hooks read BIG; a long sentence still
// fits the 1080px-wide safe area (≈900px after padding) without overflowing.
function heroFontSize(text: string): number {
  const n = text.length;
  if (n > 90) return 60;
  if (n > 60) return 72;
  if (n > 36) return 88;
  if (n > 18) return 104;
  return 120;
}

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
        backgroundImage: heroBackground(theme.palette, HERO_BACKGROUND_DEFAULT),
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 96px',
      }}
    >
      <div style={{transform: `translateY(${y}px)`, opacity: enter, textAlign: 'center', maxWidth: 900}}>
        {data.subtitle ? (
          <div
            style={{
              marginBottom: 28,
              fontFamily: `${theme.fonts.body}, system-ui, sans-serif`,
              fontWeight: 700,
              fontSize: 32,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: theme.palette.accent,
            }}
          >
            {data.subtitle}
          </div>
        ) : null}
        <div
          style={{
            fontFamily: `${theme.fonts.heading}, system-ui, sans-serif`,
            fontWeight: 800,
            fontSize: heroFontSize(data.title),
            lineHeight: 1.08,
            letterSpacing: '-0.02em',
            color: theme.palette.foreground,
            textShadow: '0 4px 32px rgba(0,0,0,0.55)',
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
      </div>
    </AbsoluteFill>
  );
};

export default Component;
