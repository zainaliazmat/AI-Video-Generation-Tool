import React from 'react';
import {AbsoluteFill, Audio, Sequence, staticFile} from 'remotion';
import {TransitionSeries, linearTiming} from '@remotion/transitions';
import type {Spec, Scene as SceneType, Theme} from './schema';
import {Captions} from './Captions';
import {deriveCaptionSuppressRanges} from './captions-suppress';
import {hookWordTimingsForScene} from './word-alignment';
import {itemTimingsForScene} from './item-timing';
import {registry} from '../../templates/registry.generated';
import {resolveAssets} from './assets';

/**
 * dB -> linear amplitude. Remotion's `volume` prop is linear 0..1.
 * Use /20 (amplitude), not /10 (power).  -18 dB -> ~0.126.
 */
const dbToLinear = (db: number): number =>
  Math.min(1, Math.max(0, Math.pow(10, db / 20)));

/**
 * Loud, deliberate placeholder for a scene/layer whose `template` id isn't a
 * `render`-kind entry in the registry (missing, or — caught by the discriminated
 * registry — a transition used where a component is required). Core renders NO
 * built-in template; a bad id FAILS VISIBLY.
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
      {templateId ? `"${templateId}"` : '(no template set)'}
    </div>
  </AbsoluteFill>
);

/** Render a scene's content via its `render`-kind template. The discriminated
 * registry guarantees a transition can't be dispatched here (it narrows out).
 * For the hook, compute the (fail-closed) per-word narration timings from the
 * captions so the headline can light word-by-word; null/absent → non-synced. */
function renderScene(
  scene: SceneType,
  theme: Theme,
  fps: number,
  durationInFrames: number,
  captions: Spec['captions'],
): React.ReactNode {
  const entry = scene.template ? registry[scene.template] : undefined;
  if (entry && entry.type === 'render') {
    const Component = entry.component;
    const title = (scene.templateProps as {title?: unknown} | undefined)?.title;
    const wordTimings =
      scene.template === 'hook' && typeof title === 'string'
        ? hookWordTimingsForScene(
            title,
            captions,
            scene.startFrame,
            scene.durationInFrames,
          ) ?? undefined
        : undefined;
    // Enumeration: per-item reveal frames, render-derived from captions ∩ span ∩
    // labels — GATED BY THE DECLARED CAPABILITY (manifest.consumes), not a hardcoded
    // id, so any template consuming "enumeration" gets synced reveals. Fail-closed.
    const items = (scene.templateProps as {items?: unknown} | undefined)?.items;
    const itemTimings =
      entry.manifest.consumes === 'enumeration' && Array.isArray(items)
        ? itemTimingsForScene(
            items as string[],
            captions,
            scene.startFrame,
            scene.durationInFrames,
          ) ?? undefined
        : undefined;
    return (
      <Component
        data={scene.templateProps ?? {}}
        theme={theme}
        timing={{fps, durationInFrames}}
        assets={resolveAssets(entry.manifest)}
        wordTimings={wordTimings}
        itemTimings={itemTimings}
      />
    );
  }
  return <MissingTemplate templateId={scene.template} />;
}

export const Video: React.FC<{spec: Spec}> = ({spec}) => {
  // Defensive: calculateMetadata always supplies a real spec before render, but
  // this guards the placeholder defaultProps from ever crashing the component.
  if (!spec) {
    return null;
  }

  const {scenes, captions, audio, theme, meta, layers} = spec;
  const fps = meta.fps;
  const lastIdx = scenes.length - 1;

  // The OUTGOING transition of scene i (i < last) that resolves to a valid
  // transition-kind template. Anything else (missing id, or a render template
  // mis-referenced as a transition) yields no transition → a hard cut.
  const transitionOf = (scene: SceneType, i: number) => {
    if (i >= lastIdx || !scene.transition) return undefined;
    const entry = registry[scene.transition.template];
    return entry && entry.type === 'transition'
      ? {entry, transition: scene.transition}
      : undefined;
  };

  const anyTransition = scenes.some((s, i) => transitionOf(s, i) !== undefined);

  // Absolute [start, end) spans of scenes whose template renders its OWN full text
  // (hook/stat/outro hero cards, declared via manifest.rendersOwnText). The global
  // karaoke caption is hidden over these so the same words don't show twice; over
  // footage scenes (rendersOwnText falsy) the caption still plays. Core hardcodes
  // no template id — the policy rides on the manifest flag (derivation is unit-
  // tested in captions-suppress.test.ts).
  const ownsText = (templateId: string | undefined): boolean => {
    const entry = templateId ? registry[templateId] : undefined;
    return Boolean(entry && entry.type === 'render' && entry.manifest.rendersOwnText);
  };
  const captionSuppressRanges = deriveCaptionSuppressRanges(scenes, ownsText);

  // With transitions, scenes go through <TransitionSeries>. Each sequence is
  // EXTENDED by its outgoing transition (dur = dᵢ + Tᵢ); TransitionSeries
  // reclaims the Tᵢ overlap, so every scene's content-start stays pinned to its
  // voiceover frame Sᵢ (zero cumulative drift) and the series total collapses to
  // Σdᵢ = meta.durationInFrames. Captions/audio/layers stay at the root on
  // absolute frames, so they remain audio-aligned.
  const sceneNodes = anyTransition ? (
    <TransitionSeries>
      {scenes.flatMap((scene, i) => {
        const tx = transitionOf(scene, i);
        const T = tx ? tx.transition.durationInFrames : 0;
        const seqDur = scene.durationInFrames + T;
        const nodes: React.ReactNode[] = [
          <TransitionSeries.Sequence key={scene.id} durationInFrames={seqDur}>
            {renderScene(scene, theme, fps, seqDur, captions)}
          </TransitionSeries.Sequence>,
        ];
        if (tx) {
          nodes.push(
            <TransitionSeries.Transition
              key={`${scene.id}-transition`}
              presentation={tx.entry.presentation(tx.transition.props)}
              timing={linearTiming({durationInFrames: T})}
            />,
          );
        }
        return nodes;
      })}
    </TransitionSeries>
  ) : (
    scenes.map((scene) => (
      <Sequence
        key={scene.id}
        from={scene.startFrame}
        durationInFrames={scene.durationInFrames}
      >
        {renderScene(scene, theme, fps, scene.durationInFrames, captions)}
      </Sequence>
    ))
  );

  return (
    <AbsoluteFill style={{backgroundColor: theme.palette.background}}>
      {/* Scenes resolve their template from the registry by id — core hardcodes
          nothing. Either laid end-to-end (<Sequence>) or, when any scene carries
          a transition, woven through <TransitionSeries> with the dᵢ+Tᵢ overlap
          absorption above. */}
      {sceneNodes}

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

      {/* Overlay layers composited on top of the scenes (overlay-kind templates),
          each in its own <Sequence>, BELOW captions so the caption band stays
          legible. Unknown/non-render id → the loud placeholder. */}
      {(layers ?? []).map((layer) => {
        const entry = registry[layer.template];
        return (
          <Sequence
            key={layer.id}
            from={layer.startFrame}
            durationInFrames={layer.durationInFrames}
          >
            {entry && entry.type === 'render' ? (
              <entry.component
                data={layer.props ?? {}}
                theme={theme}
                timing={{fps, durationInFrames: layer.durationInFrames}}
                assets={resolveAssets(entry.manifest)}
              />
            ) : (
              <MissingTemplate templateId={layer.template} />
            )}
          </Sequence>
        );
      })}

      {/* Captions overlay sits at the composition ROOT (not inside a Sequence),
          so useCurrentFrame() stays ABSOLUTE and matches the caption frames —
          audio-aligned regardless of any transition overlaps inside the scenes. */}
      <Captions
        captions={captions}
        caption={theme.caption}
        suppressRanges={captionSuppressRanges}
      />
    </AbsoluteFill>
  );
};
