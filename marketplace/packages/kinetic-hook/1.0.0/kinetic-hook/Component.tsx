import React from 'react';
import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';
import type {TemplateProps} from '../sdk';
import type {KineticHookData} from './schema';

/**
 * kinetic-hook — word-cascade opening title.
 *
 * Words of `data.title` rise + fade in with a staggered entrance. An accent
 * underline sweeps in beneath once the words have settled.
 *
 * Fail-closed: when `wordTimings` is present and matches the word count, each
 * word lights on its narration frame. Otherwise falls back to an even stagger
 * derived purely from the frame count.
 *
 * Style: theme tokens only — no hardcoded colors or fonts.
 * Runtime imports: react, remotion only.
 */

const CLAMP = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;
const STAGGER_PER_WORD = 4; // frames between each word's entrance in fallback mode
const WORD_RISE_FRAMES = 12; // rise animation duration per word

function splitWords(title: string): string[] {
  return title.trim().split(/\s+/).filter(Boolean);
}

function titleFontSize(charCount: number): number {
  if (charCount > 80) return 64;
  if (charCount > 56) return 80;
  if (charCount > 36) return 96;
  if (charCount > 20) return 116;
  return 132;
}

const Component: React.FC<TemplateProps<KineticHookData>> = ({
  data,
  theme,
  wordTimings,
}) => {
  const frame = useCurrentFrame();
  const words = splitWords(data.title);

  // Fail-closed: sync only when timing count matches word count exactly.
  const synced =
    Boolean(wordTimings) && wordTimings!.length === words.length && words.length > 0;

  // Kicker fades up over the first 10 frames.
  const kickerOpacity = interpolate(frame, [0, 10], [0, 1], CLAMP);
  const kickerY = interpolate(frame, [0, 10], [18, 0], CLAMP);

  // Underline sweeps in after the last word settles.
  const lastWordStart = synced
    ? wordTimings![words.length - 1].startFrame
    : (words.length - 1) * STAGGER_PER_WORD;
  const underlineStart = lastWordStart + WORD_RISE_FRAMES;
  const underlineEnd = underlineStart + 16;
  const underlineProgress = interpolate(frame, [underlineStart, underlineEnd], [0, 1], CLAMP);

  const fs = titleFontSize(data.title.length);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.palette.background,
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 96px',
        flexDirection: 'column',
      }}
    >
      <div style={{textAlign: 'center', maxWidth: 900}}>
        {data.kicker ? (
          <div
            style={{
              marginBottom: 24,
              fontFamily: `${theme.fonts.body}, system-ui, sans-serif`,
              fontWeight: 700,
              fontSize: 28,
              letterSpacing: '0.2em',
              textTransform: 'uppercase' as const,
              color: theme.palette.accent,
              opacity: kickerOpacity,
              transform: `translateY(${kickerY}px)`,
            }}
          >
            {data.kicker}
          </div>
        ) : null}

        {/* Word cascade */}
        <div
          style={{
            fontFamily: `${theme.fonts.heading}, system-ui, sans-serif`,
            fontWeight: 800,
            fontSize: fs,
            lineHeight: 1.1,
            letterSpacing: '-0.02em',
          }}
        >
          {words.map((word, i) => {
            // Entrance start frame for this word.
            const wordStart = synced ? wordTimings![i].startFrame : i * STAGGER_PER_WORD;
            const wordEnd = wordStart + WORD_RISE_FRAMES;
            const progress = interpolate(frame, [wordStart, wordEnd], [0, 1], CLAMP);
            const opacity = progress;
            const translateY = interpolate(progress, [0, 1], [32, 0]);

            // In synced mode, highlight the active word with the accent colour.
            const isActive =
              synced && frame >= wordTimings![i].startFrame && frame <= wordTimings![i].endFrame;
            const color = isActive ? theme.palette.accent : theme.palette.foreground;

            return (
              <React.Fragment key={i}>
                <span
                  style={{
                    display: 'inline-block',
                    opacity,
                    color,
                    transform: `translateY(${translateY}px)`,
                  }}
                >
                  {word}
                </span>
                {i < words.length - 1 ? ' ' : ''}
              </React.Fragment>
            );
          })}
        </div>

        {/* Accent underline sweep */}
        <div
          style={{
            margin: '36px auto 0',
            width: 160,
            height: 8,
            borderRadius: 999,
            backgroundColor: theme.palette.accent,
            opacity: underlineProgress,
            transform: `scaleX(${underlineProgress})`,
            transformOrigin: 'left center',
          }}
        />
      </div>
    </AbsoluteFill>
  );
};

export default Component;
