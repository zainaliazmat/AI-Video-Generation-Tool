import React from 'react';
import {AbsoluteFill, Audio, Sequence, staticFile} from 'remotion';
import type {Spec} from './schema';
import {Captions} from './Captions';
import {registry} from '../../templates/registry.generated';

/**
 * dB -> linear amplitude. Remotion's `volume` prop is linear 0..1.
 * Use /20 (amplitude), not /10 (power).  -18 dB -> ~0.126.
 */
const dbToLinear = (db: number): number =>
  Math.min(1, Math.max(0, Math.pow(10, db / 20)));

/**
 * Loud, deliberate placeholder for a scene whose `template` id isn't in the
 * registry (or is missing). Core renders NO built-in template — an unknown id
 * must FAIL VISIBLY, never silently fall back to some hardcoded renderer.
 */
const MissingTemplate: React.FC<{templateId?: string}> = ({templateId}) => (
  <AbsoluteFill
    style={{
      backgroundColor: '#7f1d1d',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 64,
      textAlign: 'center',
    }}
  >
    <div style={{fontFamily: 'monospace', fontSize: 44, fontWeight: 700, color: '#fff'}}>
      ⚠ Unknown template
    </div>
    <div style={{marginTop: 16, fontFamily: 'monospace', fontSize: 32, color: '#fecaca'}}>
      {templateId ? `"${templateId}"` : '(no template set on scene)'}
    </div>
  </AbsoluteFill>
);

export const Video: React.FC<{spec: Spec}> = ({spec}) => {
  // Defensive: calculateMetadata always supplies a real spec before render, but
  // this guards the placeholder defaultProps from ever crashing the component.
  if (!spec) {
    return null;
  }

  const {scenes, captions, audio, theme, meta} = spec;

  return (
    <AbsoluteFill style={{backgroundColor: theme.palette.background}}>
      {/* Scenes laid end to end. Each <Sequence> resets useCurrentFrame() to 0
          inside the scene's component (what per-template animation expects).
          The template is resolved from the registry by id — core hardcodes
          nothing; an unknown id renders the loud MissingTemplate placeholder. */}
      {scenes.map((scene) => {
        const entry = scene.template ? registry[scene.template] : undefined;
        return (
          <Sequence
            key={scene.id}
            from={scene.startFrame}
            durationInFrames={scene.durationInFrames}
          >
            {entry ? (
              <entry.component
                data={scene.templateProps ?? {}}
                theme={theme}
                timing={{fps: meta.fps, durationInFrames: scene.durationInFrames}}
                assets={{}}
              />
            ) : (
              <MissingTemplate templateId={scene.template} />
            )}
          </Sequence>
        );
      })}

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
          so useCurrentFrame() stays ABSOLUTE and matches the caption frames.
          Captions remain a top-level field this phase (layers[] is overlay-only). */}
      <Captions captions={captions} caption={theme.caption} />
    </AbsoluteFill>
  );
};
