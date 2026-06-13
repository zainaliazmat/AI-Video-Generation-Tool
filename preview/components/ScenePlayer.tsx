'use client';

import {Player} from '@remotion/player';
import {useMemo} from 'react';
import {Video} from '@remotion-src/Video';
import type {Spec} from '@remotion-src/schema';

/**
 * ScenePlayer — plays a single scene span on the full spec, looping within it.
 *
 * Binding mechanism (@remotion/player v4.0.472):
 *   Player supports `inFrame` and `outFrame` natively — no PlayerRef loop needed.
 *   We pass:
 *     - `durationInFrames={spec.meta.durationInFrames}` — the FULL composition
 *       duration so all scenes render at their absolute frame addresses (the Video
 *       composition reads frame numbers directly; trimming durationInFrames would
 *       shift all content to start at frame 0, rendering the wrong scene).
 *     - `inFrame={startFrame}` — Player skips frames before the scene start.
 *     - `outFrame={startFrame + durationInFrames - 1}` — Player stops after the
 *       scene end and loops back to inFrame when `loop` is set.
 *     - `initialFrame={startFrame}` — the player opens at the scene start rather
 *       than frame 0.
 *
 * The caller (T6 Scenes accordion) computes startFrame from cumulative durations
 * (accounting for transition overlap if needed). ScenePlayer trusts those props.
 */
export function ScenePlayer({
  spec,
  startFrame,
  durationInFrames,
  controls = false,
}: {
  spec: Spec;
  startFrame: number;
  durationInFrames: number;
  controls?: boolean;
}) {
  const {fps, width, height, durationInFrames: totalFrames} = spec.meta;

  // inFrame/outFrame are INCLUSIVE in the Player API.
  const outFrame = startFrame + durationInFrames - 1;

  // Stable identity so the Player doesn't remount/reset on parent re-renders.
  const inputProps = useMemo(() => ({spec}), [spec]);

  return (
    <Player
      component={Video}
      inputProps={inputProps}
      // Full composition duration — required for absolute frame addressing.
      durationInFrames={totalFrames}
      fps={fps}
      compositionWidth={width}
      compositionHeight={height}
      // Span constraints: Player will only play [startFrame, outFrame] inclusive.
      inFrame={startFrame}
      outFrame={outFrame}
      // Open at the scene start (not frame 0).
      initialFrame={startFrame}
      loop
      style={{width: '100%', display: 'block'}}
      controls={controls}
      clickToPlay={controls}
      spaceKeyToPlayOrPause={controls}
    />
  );
}
