import React from 'react';
import {interpolate, useCurrentFrame} from 'remotion';
import type {TemplateProps} from '../sdk';
import type {HookData} from './schema';
import HeroBackdrop from '../HeroBackdrop';
import {splitDisplayWords} from '../../remotion/src/word-alignment';
import {wordRevealState} from '../../remotion/src/hook-reveal';

/**
 * `hook` — the opening attention-grabber. The spoken hook line (`title`) is the
 * HERO. When the renderer supplies per-word narration timings (`wordTimings`),
 * the headline is a single VOICE-LOCKED REVEAL: present-but-dim-and-legible from
 * frame 0, each word brightening + accenting exactly as it is spoken. With no
 * timings (alignment failed / absent) it FALLS BACK to the Round-1 staggered
 * entrance — a clean reveal is always better than a drifting one (fail-closed).
 * The kicker and the breathing background are identical in both modes.
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

// Underline behaviour in synced mode (gate decides on pixels):
//   'completion' — a quiet underline appears once the last word finishes.
//   'sweep'      — the underline tracks narration progress across the hook.
// Widen to the union so the === 'sweep' branch compiles even though the default
// is 'completion'. The gate (a later task) will flip this to 'sweep' if desired.
const HOOK_UNDERLINE_MODE: 'completion' | 'sweep' =
  'completion' as 'completion' | 'sweep';

const Component: React.FC<TemplateProps<HookData>> = ({data, theme, timing, wordTimings}) => {
  const frame = useCurrentFrame();
  const words = splitDisplayWords(data.title);
  // Fail-closed: only sync when we have exactly one timing per display word.
  const synced = Boolean(wordTimings && words.length > 0 && wordTimings.length === words.length);

  // Kicker is identical in both modes (Round-1 stagger).
  const kicker = interpolate(frame, [0, 10], [0, 1], CLAMP);

  const headlineBase: React.CSSProperties = {
    fontFamily: `${theme.fonts.heading}, system-ui, sans-serif`,
    fontWeight: 800,
    fontSize: heroFontSize(data.title),
    lineHeight: 1.08,
    letterSpacing: '-0.02em',
    color: theme.palette.foreground,
    textShadow: '0 4px 32px rgba(0,0,0,0.55)',
  };

  return (
    <HeroBackdrop
      clip={data.backgroundClip}
      palette={theme.palette}
      frame={frame}
      durationInFrames={timing.durationInFrames}
      containerStyle={{alignItems: 'center', justifyContent: 'center', padding: '0 96px'}}
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

        {synced ? (
          <SyncedHeadline
            words={words}
            timings={wordTimings as NonNullable<typeof wordTimings>}
            frame={frame}
            base={headlineBase}
            accent={theme.palette.accent}
          />
        ) : (
          <FallbackHeadline title={data.title} frame={frame} base={headlineBase} />
        )}

        <Underline
          synced={synced}
          frame={frame}
          accent={theme.palette.accent}
          firstStart={synced ? wordTimings![0].startFrame : 0}
          lastEnd={synced ? wordTimings![wordTimings!.length - 1].endFrame : 0}
        />
      </div>
    </HeroBackdrop>
  );
};

/** Round-2 voice-locked reveal: dim-from-frame-0 words that light as spoken. */
const SyncedHeadline: React.FC<{
  words: string[];
  timings: NonNullable<TemplateProps<HookData>['wordTimings']>;
  frame: number;
  base: React.CSSProperties;
  accent: string;
}> = ({words, timings, frame, base, accent}) => (
  <div style={{...base, opacity: 1}}>
    {words.map((w, i) => {
      const st = wordRevealState(frame, timings[i]);
      return (
        <React.Fragment key={i}>
          <span
            style={{
              display: 'inline-block',
              opacity: st.opacity,
              color: st.isActive ? accent : base.color,
              transform: `scale(${st.scale})`,
            }}
          >
            {w}
          </span>
          {i < words.length - 1 ? ' ' : ''}
        </React.Fragment>
      );
    })}
  </div>
);

/** Round-1 fallback: the monolithic headline cascade (rise + fade as one block). */
const FallbackHeadline: React.FC<{
  title: string;
  frame: number;
  base: React.CSSProperties;
}> = ({title, frame, base}) => {
  const headline = interpolate(frame, [5, 18], [0, 1], CLAMP);
  return (
    <div
      style={{
        ...base,
        opacity: headline,
        transform: `translateY(${interpolate(headline, [0, 1], [40, 0])}px)`,
      }}
    >
      {title}
    </div>
  );
};

/** Underline. Round-1 stagger when not synced; in synced mode either appears on
 * completion or sweeps with narration progress (HOOK_UNDERLINE_MODE). */
const Underline: React.FC<{
  synced: boolean;
  frame: number;
  accent: string;
  firstStart: number;
  lastEnd: number;
}> = ({synced, frame, accent, firstStart, lastEnd}) => {
  let opacity: number;
  let scaleX: number;
  if (!synced) {
    const u = interpolate(frame, [13, 24], [0, 1], CLAMP); // Round-1 stagger
    opacity = u;
    scaleX = u;
  } else if (HOOK_UNDERLINE_MODE === 'sweep') {
    const p = interpolate(frame, [firstStart, lastEnd], [0, 1], CLAMP);
    opacity = interpolate(frame, [firstStart, firstStart + 6], [0, 1], CLAMP);
    scaleX = p;
  } else {
    const u = interpolate(frame, [lastEnd, lastEnd + 8], [0, 1], CLAMP); // completion
    opacity = u;
    scaleX = u;
  }
  return (
    <div
      style={{
        margin: '40px auto 0',
        width: 140,
        height: 10,
        borderRadius: 999,
        backgroundColor: accent,
        opacity,
        transform: `scaleX(${scaleX})`,
        transformOrigin: synced && HOOK_UNDERLINE_MODE === 'sweep' ? 'left center' : 'center',
      }}
    />
  );
};

export default Component;
