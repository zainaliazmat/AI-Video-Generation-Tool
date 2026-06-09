import React from 'react';
import {AbsoluteFill, Img, staticFile, useCurrentFrame} from 'remotion';
import type {TemplateProps} from '../sdk';
import type {EnumerationData} from './schema';
import {heroBackground, HERO_BREATH_PERIOD} from '../heroBackground';
import {resolveMedia, iconNameFor, monogram} from './media';
import {LucideGlyph} from './LucideGlyph';
import {itemRevealState} from './reveal';
import {activeIndex, heroPresence, heroLabelOpacity} from './heroState';
import {enumerationSizing, listBandHeight, HERO_BAND_FRACTION} from './sizing';

/**
 * `enumeration` — Tier 2 image-as-hero. Each item's beat is presented big in a HERO
 * zone (curated NASA PD image, else a large lucide icon, else a mark) keyed to the
 * voice-locked onset; the active hero crossfades to the next as it is spoken. A
 * persistent running LIST below shows every revealed item (active row emphasized),
 * preserving the 1.2.3 count. Voice-lock, itemRevealState, caption suppression and
 * the cascade are all frozen plumbing. rendersOwnText:true suppresses the caption.
 */
function fallbackStartFrames(n: number, durationInFrames: number): number[] {
  const lead = 8;
  const usable = Math.max(1, durationInFrames - lead - 12);
  const denom = Math.max(1, n - 1);
  return Array.from({length: n}, (_, i) => lead + Math.round((usable * i) / denom));
}

const HERO_IMG = 640; // hero image box (px)
const HERO_ICON = 360; // large lucide hero (px)

const Component: React.FC<TemplateProps<EnumerationData>> = ({data, theme, timing, itemTimings}) => {
  const frame = useCurrentFrame();
  const items = data.items;
  const synced = Boolean(itemTimings && itemTimings.length === items.length);
  const starts = synced
    ? (itemTimings as NonNullable<typeof itemTimings>).map((t) => t.startFrame)
    : fallbackStartFrames(items.length, timing.durationInFrames);
  const active = activeIndex(frame, starts);
  const sz = enumerationSizing(items.length, listBandHeight()); // SAME helper the test guards

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.palette.background,
        backgroundImage: heroBackground(theme.palette, frame / HERO_BREATH_PERIOD),
      }}
    >
      {/* HERO ZONE */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: `${HERO_BAND_FRACTION * 100}%`,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '0 80px',
        }}
      >
        {items.map((label, i) => {
          const present = heroPresence(frame, i, starts);
          const labelOpacity = heroLabelOpacity(frame, i, starts);
          if (present <= 0) return null;
          const st = itemRevealState(frame, starts[i], i + 1 < starts.length ? starts[i + 1] : starts[i] + 24);
          const media = resolveMedia(label);
          const mg = monogram(label);
          const ring = `0 0 0 6px ${theme.palette.accent}55, 0 30px 80px rgba(0,0,0,0.6)`;
          return (
            <div
              key={i}
              style={{
                position: 'absolute',
                // The outer div carries only the shared pop+rise transform. Opacity is split:
                // the IMAGE cross-dissolves (heroPresence), but the LABEL fades through nothing
                // (heroLabelOpacity) so two names never overprint at the shared baseline.
                transform: `translateY(${st.translateY}px) scale(${st.scale})`,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 36,
              }}
            >
              {/* image dissolve: heroPresence (already ramps over min(ENTER,gap)) */}
              <div style={{opacity: present, display: 'flex'}}>
                {media.kind === 'image' ? (
                  <Img
                    src={staticFile(media.src)}
                    alt={media.alt}
                    style={{
                      width: HERO_IMG,
                      height: HERO_IMG,
                      objectFit: 'cover',
                      borderRadius: 40,
                      boxShadow: ring,
                      background: '#000',
                    }}
                  />
                ) : media.kind === 'icon' ? (
                  <div style={{width: HERO_IMG, height: HERO_IMG, display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
                    <LucideGlyph name={media.name} size={HERO_ICON} color={theme.palette.foreground} />
                  </div>
                ) : mg ? (
                  <div
                    style={{
                      width: HERO_IMG,
                      height: HERO_IMG,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: 40,
                      boxShadow: ring,
                      background: '#000',
                      fontFamily: `${theme.fonts.heading}, system-ui, sans-serif`,
                      fontWeight: 800,
                      fontSize: HERO_ICON,
                      color: theme.palette.accent,
                    }}
                  >
                    {mg}
                  </div>
                ) : (
                  <div style={{width: HERO_IMG, height: HERO_IMG, display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
                    <LucideGlyph name="circle" size={HERO_ICON} color={theme.palette.foreground} />
                  </div>
                )}
              </div>
              <div
                style={{
                  // fade-through-nothing: outgoing name reaches 0 before incoming begins
                  opacity: labelOpacity,
                  fontFamily: `${theme.fonts.heading}, system-ui, sans-serif`,
                  fontWeight: 800,
                  fontSize: 92,
                  letterSpacing: '-0.01em',
                  color: theme.palette.accent,
                  textShadow: '0 4px 24px rgba(0,0,0,0.5)',
                }}
              >
                {label}
              </div>
            </div>
          );
        })}
      </div>

      {/* RUNNING LIST */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          width: '100%',
          height: `${(1 - HERO_BAND_FRACTION) * 100}%`,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          justifyContent: 'center',
          gap: sz.rowGap,
          padding: '0 120px',
        }}
      >
        {items.map((label, i) => {
          if (starts[i] > frame) return null; // not yet revealed
          // subtler appear (fade + small rise), NOT the hero overshoot
          const appear = Math.min(1, Math.max(0, (frame - starts[i]) / 8));
          const isActive = i === active;
          const media = resolveMedia(label);
          const iconColor = isActive ? theme.palette.accent : theme.palette.muted;
          const textColor = isActive ? theme.palette.accent : theme.palette.foreground;
          return (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: Math.round(sz.iconSize * 0.45),
                opacity: appear * (isActive ? 1 : 0.72),
                transform: `translateY(${(1 - appear) * 14}px)`,
              }}
            >
              <span style={{width: sz.iconSize, height: sz.iconSize, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0}}>
                {media.kind === 'mark' ? (
                  <LucideGlyph name="circle" size={Math.round(sz.iconSize * 0.82)} color={iconColor} />
                ) : (
                  // image item -> its icon (iconNameFor); icon item -> that name.
                  <LucideGlyph
                    name={media.kind === 'icon' ? media.name : iconNameFor(label) ?? 'circle'}
                    size={Math.round(sz.iconSize * 0.82)}
                    color={iconColor}
                  />
                )}
              </span>
              <span
                style={{
                  fontFamily: `${theme.fonts.heading}, system-ui, sans-serif`,
                  fontWeight: isActive ? 800 : 700,
                  fontSize: sz.labelSize,
                  color: textColor,
                  textShadow: '0 2px 12px rgba(0,0,0,0.5)',
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
