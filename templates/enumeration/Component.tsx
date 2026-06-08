import React from 'react';
import {AbsoluteFill, useCurrentFrame} from 'remotion';
import type {TemplateProps} from '../sdk';
import type {EnumerationData} from './schema';
import {heroBackground, HERO_BREATH_PERIOD} from '../heroBackground';
import {iconForLabel} from './icons';
import {itemRevealState} from './reveal';

/**
 * `enumeration` — an enumerable set (e.g. sun/moon/planets/eclipse/phases) revealed
 * one-by-one IN SYNC with the narration. When the renderer supplies per-item
 * narration timings (`itemTimings`), each item enters exactly as its label is
 * spoken; with no timings (alignment failed / absent) it FALLS BACK to a uniform
 * even-staggered entrance (fail-closed, set-level — a clean reveal beats a drifting
 * one). The manifest's rendersOwnText:true suppresses the global karaoke caption
 * over this scene so the spoken labels don't show twice. Background matches the
 * hero cards (breathing spotlight).
 */

// Even-staggered fallback: distribute reveals across the span when not voice-locked.
function fallbackStartFrames(n: number, durationInFrames: number): number[] {
  const lead = 8;
  const tail = 12;
  const usable = Math.max(1, durationInFrames - lead - tail);
  const denom = Math.max(1, n - 1);
  return Array.from({length: n}, (_, i) => lead + Math.round((usable * i) / denom));
}

const Component: React.FC<TemplateProps<EnumerationData>> = ({data, theme, timing, itemTimings}) => {
  const frame = useCurrentFrame();
  const items = data.items;
  // Fail-closed: only sync when we have exactly one timing per item.
  const synced = Boolean(itemTimings && itemTimings.length === items.length);
  const starts = synced
    ? (itemTimings as NonNullable<typeof itemTimings>).map((t) => t.startFrame)
    : fallbackStartFrames(items.length, timing.durationInFrames);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.palette.background,
        backgroundImage: heroBackground(theme.palette, frame / HERO_BREATH_PERIOD),
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 120px',
      }}
    >
      <div style={{display: 'flex', flexDirection: 'column', gap: 40, width: '100%', maxWidth: 840}}>
        {items.map((label, i) => {
          const st = itemRevealState(frame, starts[i]);
          return (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 36,
                opacity: st.opacity,
                transform: `translateY(${st.translateY}px) scale(${st.scale})`,
                transformOrigin: 'left center',
              }}
            >
              <span
                style={{
                  fontSize: 92,
                  lineHeight: 1,
                  width: 104,
                  textAlign: 'center',
                  flexShrink: 0,
                  // Color emoji carry their own color; this only tints the monochrome
                  // FALLBACK_ICON so it stays visible on the dark gradient (else the
                  // ● renders black-on-dark and disappears — caught at the emoji still).
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
                  fontSize: 64,
                  letterSpacing: '-0.01em',
                  color: theme.palette.foreground,
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
