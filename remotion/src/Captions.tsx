import React, {useMemo} from 'react';
import {
  AbsoluteFill,
  Easing,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {loadFont} from '@remotion/google-fonts/Inter';
import type {Caption, CaptionStyle} from './schema';
import {isFrameSuppressed, type FrameRange} from './captions-suppress';
import {resolveCaptionFontSize} from './caption-size';

// Load Inter ONCE at module top-level. loadFont auto-manages delayRender, so the
// render blocks until glyphs are ready — no fallback-font flash, no manual
// waitUntilDone(). The weight must be LOADED ("800"), not just set in CSS.
const {fontFamily} = loadFont('normal', {
  weights: ['800'],
  subsets: ['latin'],
});

// Karaoke window: how many words to show around the active one.
const WINDOW_SIZE = 3;

/** Index of the word whose [startFrame, endFrame] contains `frame`, else -1. */
function findActiveIndex(captions: Caption[], frame: number): number {
  for (let i = 0; i < captions.length; i++) {
    const c = captions[i];
    if (frame >= c.startFrame && frame <= c.endFrame) {
      return i;
    }
  }
  return -1;
}

/**
 * Word to anchor the window on. When no word is active (a gap), anchor on the
 * most-recently-started word so the band never blanks out mid-sentence.
 */
function findAnchorIndex(captions: Caption[], frame: number): number {
  const active = findActiveIndex(captions, frame);
  if (active !== -1) {
    return active;
  }
  if (captions.length === 0 || frame < captions[0].startFrame) {
    return captions.length === 0 ? -1 : 0;
  }
  let anchor = captions.length - 1;
  for (let i = 0; i < captions.length; i++) {
    if (captions[i].startFrame > frame) {
      anchor = Math.max(0, i - 1);
      break;
    }
  }
  return anchor;
}

export const Captions: React.FC<{
  captions: Caption[];
  caption: CaptionStyle;
  /**
   * Absolute [start, end) frame spans (half-open) over which the karaoke caption
   * is hidden — the full-text hero cards (hook/stat/outro) already render their
   * own text, so showing the same words again duplicates them. Footage scenes are
   * not in this list, so captions still play over footage. Empty/absent = always
   * show (the previous behavior).
   */
  suppressRanges?: ReadonlyArray<FrameRange>;
}> = ({captions, caption: style, suppressRanges}) => {
  // ROOT-level component => useCurrentFrame() is ABSOLUTE, matching the absolute
  // startFrame/endFrame in captions[]. Do not offset.
  const frame = useCurrentFrame();
  const {height} = useVideoConfig();

  // Suppressed over full-text hero cards (half-open so the contiguous scene
  // boundary frame isn't double-counted). The card is the text treatment there.
  const suppressed = isFrameSuppressed(frame, suppressRanges ?? []);

  const activeIndex = useMemo(
    () => findActiveIndex(captions, frame),
    [captions, frame],
  );
  const anchorIndex = useMemo(
    () => findAnchorIndex(captions, frame),
    [captions, frame],
  );

  const windowWords = useMemo(() => {
    if (anchorIndex === -1) {
      return [] as {caption: Caption; index: number}[];
    }
    const half = Math.floor(WINDOW_SIZE / 2);
    let start = anchorIndex - half;
    let end = start + WINDOW_SIZE;
    if (start < 0) {
      start = 0;
      end = Math.min(captions.length, WINDOW_SIZE);
    }
    if (end > captions.length) {
      end = captions.length;
      start = Math.max(0, end - WINDOW_SIZE);
    }
    const slice: {caption: Caption; index: number}[] = [];
    for (let i = start; i < end; i++) {
      slice.push({caption: captions[i], index: i});
    }
    return slice;
  }, [captions, anchorIndex]);

  if (suppressed || windowWords.length === 0) {
    return null;
  }

  // Carry the highlight onto the most-recent word during inter-word gaps (and
  // after the final word) so the karaoke never flickers off between words.
  // No highlight before the first word starts.
  const highlightIndex =
    activeIndex !== -1
      ? activeIndex
      : captions.length > 0 && frame >= captions[0].startFrame
        ? anchorIndex
        : -1;

  // positionY: 0 (top) .. 1 (bottom). translateY(-50%) anchors the band on its
  // own vertical center so the extremes don't clip.
  const topPx = interpolate(style.positionY, [0, 1], [0, height], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const fontSize = resolveCaptionFontSize(style.size, height); // absent -> ~86px at 1920
  const strokeWidth = Math.max(2, Math.round(fontSize * 0.09));

  return (
    <AbsoluteFill>
      <div
        style={{
          position: 'absolute',
          top: topPx,
          left: 0,
          width: '100%',
          transform: 'translateY(-50%)',
          display: 'flex',
          flexDirection: 'row',
          flexWrap: 'wrap',
          justifyContent: 'center',
          alignItems: 'center',
          // Generous gap so a scaled active word (which overflows its layout
          // box, since CSS scale() doesn't reflow) never collides with neighbors.
          gap: `${Math.round(fontSize * 0.55)}px`,
          padding: `0 ${Math.round(height * 0.04)}px`,
          textAlign: 'center',
        }}
      >
        {windowWords.map(({caption, index}) => {
          const isActive = index === highlightIndex;
          const scale = isActive
            ? interpolate(
                frame,
                [caption.startFrame, caption.startFrame + 3],
                [0.92, 1.1],
                {
                  extrapolateLeft: 'clamp',
                  extrapolateRight: 'clamp',
                  easing: Easing.out(Easing.cubic),
                },
              )
            : 1;

          return (
            <span
              key={index}
              style={{
                display: 'inline-block',
                fontFamily,
                fontWeight: style.fontWeight,
                fontSize,
                lineHeight: 1.1,
                color: isActive
                  ? style.highlightColor
                  : style.color,
                transform: `scale(${scale})`,
                transformOrigin: 'center',
                WebkitTextStroke: `${strokeWidth}px ${style.strokeColor}`,
                paintOrder: 'stroke',
                textShadow: `0 ${Math.round(fontSize * 0.04)}px ${Math.round(
                  fontSize * 0.12,
                )}px rgba(0,0,0,0.55)`,
                whiteSpace: 'pre',
              }}
            >
              {caption.text}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
