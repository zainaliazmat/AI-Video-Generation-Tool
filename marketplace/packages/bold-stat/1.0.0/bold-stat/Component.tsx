import React from 'react';
import {AbsoluteFill, Easing, interpolate, useCurrentFrame} from 'remotion';
import type {TemplateProps} from '../sdk';
import type {BoldStatData} from './schema';

/**
 * bold-stat — big number with count-up + label.
 *
 * `data.value` is displayed in oversized text with an overshoot pop-in.
 * When value starts with a whole number (e.g. "90%", "42 kg"), the number
 * counts up from 0 to the target over the first ~30 frames.
 * `data.label` fades in just after.
 *
 * Style: theme tokens only — no hardcoded colors or fonts.
 * Runtime imports: react, remotion only.
 */

const CLAMP = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;
const COUNT_FRAMES = 30;

/** Parse a leading integer from the value string, returning null if not found. */
function parseLeadingInt(
  value: string,
): {target: number; suffix: string; useCommas: boolean} | null {
  const m = value.trim().match(/^(\d[\d,]*)(.*)$/);
  if (!m) return null;
  const num = parseInt(m[1].replace(/,/g, ''), 10);
  if (isNaN(num) || num <= 0) return null;
  const useCommas = m[1].includes(',') || num >= 1000;
  return {target: num, suffix: m[2], useCommas};
}

function formatInt(n: number, useCommas: boolean): string {
  if (!useCommas) return String(n);
  return n.toLocaleString('en-US');
}

function valueFontSize(text: string): number {
  const fit = 880 / (Math.max(text.length, 1) * 0.65);
  return Math.max(64, Math.min(240, Math.round(fit)));
}

const Component: React.FC<TemplateProps<BoldStatData>> = ({data, theme}) => {
  const frame = useCurrentFrame();

  // Pop-in scale overshoot.
  const pop = interpolate(frame, [0, 14], [0.55, 1], {
    ...CLAMP,
    easing: Easing.out(Easing.back(1.8)),
  });

  // Label fade.
  const labelFade = interpolate(frame, [8, 22], [0, 1], CLAMP);

  // Count-up.
  const parsed = parseLeadingInt(data.value);
  let display: string;
  if (parsed) {
    const counted = Math.floor(
      interpolate(frame, [0, COUNT_FRAMES], [0, parsed.target], {
        ...CLAMP,
        easing: Easing.out(Easing.cubic),
      }),
    );
    display = formatInt(counted, parsed.useCommas) + parsed.suffix;
  } else {
    display = data.value;
  }

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.palette.background,
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 80px',
        textAlign: 'center',
        flexDirection: 'column',
      }}
    >
      {/* Big value */}
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

      {/* Label */}
      <div
        style={{
          marginTop: 32,
          maxWidth: 680,
          fontFamily: `${theme.fonts.body}, system-ui, sans-serif`,
          fontWeight: 600,
          fontSize: 48,
          lineHeight: 1.25,
          color: theme.palette.foreground,
          opacity: labelFade,
          transform: `translateY(${interpolate(labelFade, [0, 1], [14, 0])}px)`,
        }}
      >
        {data.label}
      </div>
    </AbsoluteFill>
  );
};

export default Component;
