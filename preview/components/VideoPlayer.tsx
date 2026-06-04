'use client';

import {Player, type PlayerRef} from '@remotion/player';
import {useMemo, useRef} from 'react';
import {Video} from '@remotion-src/Video';
import type {Spec} from '@remotion-src/schema';

/**
 * The @remotion/player embed. Imported only via PlayerClient's dynamic
 * {ssr:false} so the Remotion tree never server-renders. The Player takes
 * duration/fps/dimensions DIRECTLY (it does not run calculateMetadata); we read
 * them from spec.meta and forward the spec through inputProps.
 */
export function VideoPlayer({spec}: {spec: Spec}) {
  const playerRef = useRef<PlayerRef>(null);
  const {fps, width, height, durationInFrames} = spec.meta;

  // Stable identity so the Player doesn't remount/reset the timeline each render.
  const inputProps = useMemo(() => ({spec}), [spec]);

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
      controls
      clickToPlay
      spaceKeyToPlayOrPause
    />
  );
}
