import React from 'react';
import {AbsoluteFill, Audio, Sequence, staticFile} from 'remotion';
import type {Spec} from './schema';
import {Scene} from './Scene';
import {Captions} from './Captions';

/**
 * dB -> linear amplitude. Remotion's `volume` prop is linear 0..1.
 * Use /20 (amplitude), not /10 (power).  -18 dB -> ~0.126.
 */
const dbToLinear = (db: number): number =>
  Math.min(1, Math.max(0, Math.pow(10, db / 20)));

export const Video: React.FC<{spec: Spec}> = ({spec}) => {
  // Defensive: calculateMetadata always supplies a real spec before render, but
  // this guards the placeholder defaultProps from ever crashing the component.
  if (!spec) {
    return null;
  }

  const {scenes, captions, audio, style} = spec;

  return (
    <AbsoluteFill style={{backgroundColor: 'black'}}>
      {/* Scenes laid end to end. Each <Sequence> resets useCurrentFrame() to 0
          inside <Scene>, which is what the Ken Burns interpolation expects. */}
      {scenes.map((scene) => (
        <Sequence
          key={scene.id}
          from={scene.startFrame}
          durationInFrames={scene.durationInFrames}
        >
          <Scene media={scene.media} durationInFrames={scene.durationInFrames} />
        </Sequence>
      ))}

      {/* Audio bed. Voiceover spans the whole composition. Music (if any) is
          ducked via dB->linear and looped; the composition duration bounds it. */}
      <Audio src={staticFile(audio.voiceover)} />
      {audio.music ? (
        <Audio
          src={staticFile(audio.music)}
          volume={dbToLinear(audio.musicVolumeDb)}
          loop
        />
      ) : null}

      {/* Captions overlay sits at the composition ROOT (not inside a Sequence),
          so useCurrentFrame() stays ABSOLUTE and matches the caption frames. */}
      <Captions captions={captions} style={style} />
    </AbsoluteFill>
  );
};
