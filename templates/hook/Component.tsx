import React from 'react';
import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';
import type {TemplateProps} from '../sdk';
import type {HookData} from './schema';
import {heroBackground} from '../heroBackground';

/**
 * `hook` — the opening attention-grabber. The spoken hook line (`title`) is the
 * HERO: large, high-contrast, and auto-sized so a full sentence fills the frame
 * without overflowing. An optional `subtitle` rides above as a small accent
 * kicker (the video's topic). The kicker, headline, and underline rise+fade in
 * on a short STAGGER (not a hard cut); fully theme-driven, so it re-themes free.
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

const CLAMP = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;

const Component: React.FC<TemplateProps<HookData>> = ({data, theme}) => {
  const frame = useCurrentFrame();
  // Staggered entrance windows (frames): kicker → headline → underline, so the
  // card builds in rather than appearing all at once on a hard cut.
  const kicker = interpolate(frame, [0, 10], [0, 1], CLAMP);
  const headline = interpolate(frame, [5, 18], [0, 1], CLAMP);
  const underline = interpolate(frame, [13, 24], [0, 1], CLAMP);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.palette.background,
        backgroundImage: heroBackground(theme.palette),
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 96px',
      }}
    >
      <div style={{textAlign: 'center', maxWidth: 900}}>
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
              opacity: kicker,
              transform: `translateY(${interpolate(kicker, [0, 1], [24, 0])}px)`,
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
            opacity: headline,
            transform: `translateY(${interpolate(headline, [0, 1], [40, 0])}px)`,
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
            opacity: underline,
            transform: `scaleX(${underline})`,
          }}
        />
      </div>
    </AbsoluteFill>
  );
};

export default Component;
