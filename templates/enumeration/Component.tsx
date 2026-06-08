import React from 'react';
import {AbsoluteFill, useCurrentFrame} from 'remotion';
import type {TemplateProps} from '../sdk';
import type {EnumerationData} from './schema';
import {heroBackground, HERO_BREATH_PERIOD} from '../heroBackground';
import {iconForLabel} from './icons';
import {itemRevealState} from './reveal';
import {enumerationSizing} from './sizing';

/**
 * `enumeration` — an enumerable set revealed one-by-one IN SYNC with the narration.
 * Each item enters with a back-ease overshoot exactly as its label is spoken (or,
 * fail-closed, on an even-staggered cadence); the just-revealed item is briefly
 * accented and the accent decays as the next item reveals (only the active item
 * lit). The column is centered and auto-fits the item count to fill the frame.
 * rendersOwnText:true suppresses the global caption. (Tier 1: emoji icons stay;
 * Tier 2 swaps them for a designed set.)
 */

// Even-staggered fallback starts when there are no voice-locked timings.
function fallbackStartFrames(n: number, durationInFrames: number): number[] {
  const lead = 8;
  const usable = Math.max(1, durationInFrames - lead - 12);
  const denom = Math.max(1, n - 1);
  return Array.from({length: n}, (_, i) => lead + Math.round((usable * i) / denom));
}

const LAST_WINDOW = 24; // the last item's accent window (no "next item" to bound it)

const Component: React.FC<TemplateProps<EnumerationData>> = ({data, theme, timing, itemTimings}) => {
  const frame = useCurrentFrame();
  const items = data.items;
  const synced = Boolean(itemTimings && itemTimings.length === items.length);
  const starts = synced
    ? (itemTimings as NonNullable<typeof itemTimings>).map((t) => t.startFrame)
    : fallbackStartFrames(items.length, timing.durationInFrames);
  // active window [start_i, end_i): end = next start, last = start + LAST_WINDOW (capped).
  const ends = starts.map((s, i) =>
    i < starts.length - 1 ? starts[i + 1] : Math.min(s + LAST_WINDOW, timing.durationInFrames),
  );
  const sz = enumerationSizing(items.length);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.palette.background,
        backgroundImage: heroBackground(theme.palette, frame / HERO_BREATH_PERIOD),
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 96px',
      }}
    >
      {/* centered block; rows left-aligned so icons line up vertically */}
      <div style={{display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: sz.rowGap}}>
        {items.map((label, i) => {
          const st = itemRevealState(frame, starts[i], ends[i]);
          // active highlight: label tints foreground → accent while lit, with a small pop.
          const labelColor = st.accent > 0.5 ? theme.palette.accent : theme.palette.foreground;
          const accentPop = 1 + 0.06 * st.accent;
          return (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: Math.round(sz.iconSize * 0.38),
                opacity: st.opacity,
                transform: `translateY(${st.translateY}px) rotate(${st.rotate}deg) scale(${st.scale * accentPop})`,
                transformOrigin: 'left center',
              }}
            >
              <span
                style={{
                  fontSize: sz.iconSize,
                  lineHeight: 1,
                  width: Math.round(sz.iconSize * 1.12),
                  textAlign: 'center',
                  flexShrink: 0,
                  // emoji keep their own color; this tints the mono fallback mark so it stays visible.
                  color: theme.palette.muted,
                  filter: 'drop-shadow(0 4px 18px rgba(0,0,0,0.5))',
                }}
              >
                {iconForLabel(label)}
              </span>
              <span
                style={{
                  fontFamily: `${theme.fonts.heading}, system-ui, sans-serif`,
                  fontWeight: 800,
                  fontSize: sz.labelSize,
                  letterSpacing: '-0.01em',
                  color: labelColor,
                  textShadow: '0 4px 24px rgba(0,0,0,0.5)',
                }}
              >
                {label}
              </span>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

export default Component;
