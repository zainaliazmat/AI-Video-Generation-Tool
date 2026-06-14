'use client';

import {Player, type PlayerRef} from '@remotion/player';
import {useEffect, useMemo, useRef} from 'react';
import {Video} from '@remotion-src/Video';
import type {Spec} from '@remotion-src/schema';

/**
 * The @remotion/player embed. Imported only via PlayerClient's dynamic
 * {ssr:false} so the Remotion tree never server-renders. The Player takes
 * duration/fps/dimensions DIRECTLY (it does not run calculateMetadata); we read
 * them from spec.meta and forward the spec through inputProps.
 *
 * v3 M6 (T6): `paused` pauses the rail player while a per-scene player plays
 * (mount-budget partner stays mounted, just stopped); `playSignal` is a counter
 * the rail bumps to request a play-from-frame-0 (the arrival auto-play, ruling
 * 12 — best-effort: browsers may block autoplay-with-audio without a gesture).
 */
export function VideoPlayer({
  spec,
  controls = true,
  paused = false,
  playSignal = 0,
}: {
  spec: Spec;
  controls?: boolean;
  paused?: boolean;
  playSignal?: number;
}) {
  const playerRef = useRef<PlayerRef>(null);
  const {fps, width, height, durationInFrames} = spec.meta;

  // Stable identity so the Player doesn't remount/reset the timeline each render.
  const inputProps = useMemo(() => ({spec}), [spec]);

  // Auto-pause when a scene player takes over (T6).
  useEffect(() => {
    if (paused) {
      try {
        playerRef.current?.pause();
      } catch {
        /* ref not ready — ignore */
      }
    }
  }, [paused]);

  // Arrival auto-play: seek to 0 and play when the signal bumps (ruling 12).
  useEffect(() => {
    if (playSignal <= 0) return;
    try {
      playerRef.current?.seekTo(0);
      const r = playerRef.current?.play();
      // play() may return a promise that rejects under autoplay policy.
      if (r && typeof (r as Promise<void>).catch === 'function') {
        (r as Promise<void>).catch(() => {});
      }
    } catch {
      /* autoplay blocked / ref not ready — leave paused */
    }
  }, [playSignal]);

  return (
    <Player
      ref={playerRef}
      component={Video}
      inputProps={inputProps}
      durationInFrames={durationInFrames}
      fps={fps}
      compositionWidth={width}
      compositionHeight={height}
      style={{width: '100%', display: 'block'}}
      controls={controls}
      clickToPlay={controls}
      spaceKeyToPlayOrPause={controls}
    />
  );
}
