import React from 'react';
import {AbsoluteFill, useVideoConfig} from 'remotion';
import {TransitionSeries, linearTiming} from '@remotion/transitions';
import {registry} from '../../templates/registry.generated';
import type {Theme} from './schema';
import {resolveAssets} from './assets';

/**
 * Renders ONE template in isolation from its `sampleProps`, for the gallery's
 * auto-generated previews (step 5). Kind is derived from the registry:
 *   - `render`  → the template component over the theme background (one scene).
 *   - `transition` → two labelled placeholder cards with the transition between
 *     them, so the motion is actually visible.
 * An unknown id paints the same loud placeholder spirit as the main renderer.
 *
 * Preview-only defaults live here (a clean default theme matching real output),
 * so the gen script only has to pass {templateId, props}.
 */

export const DEFAULT_PREVIEW_THEME: Theme = {
  palette: {background: '#000000', foreground: '#FFFFFF', accent: '#FFE600', muted: '#9CA3AF'},
  fonts: {heading: 'Inter', body: 'Inter'},
  transition: 'fade',
  caption: {
    fontFamily: 'Inter',
    fontWeight: 800,
    color: '#FFFFFF',
    highlightColor: '#FFE600',
    strokeColor: '#000000',
    positionY: 0.78,
  },
};

export type TemplatePreviewProps = {
  templateId: string;
  props?: Record<string, unknown>;
  theme?: Theme;
};

const Unknown: React.FC<{id: string}> = ({id}) => (
  <AbsoluteFill
    style={{
      backgroundColor: '#7f1d1d',
      color: '#fff',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: 'monospace',
      fontSize: 40,
    }}
  >
    ⚠ Unknown template "{id}"
  </AbsoluteFill>
);

/** A simple labelled card so a transition's motion reads clearly in the preview. */
const PlaceholderCard: React.FC<{label: string; bg: string; fg: string}> = ({label, bg, fg}) => (
  <AbsoluteFill
    style={{
      backgroundColor: bg,
      color: fg,
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: 'Inter, sans-serif',
      fontSize: 220,
      fontWeight: 800,
    }}
  >
    {label}
  </AbsoluteFill>
);

export const TemplatePreview: React.FC<TemplatePreviewProps> = ({
  templateId,
  props = {},
  theme = DEFAULT_PREVIEW_THEME,
}) => {
  const {fps, durationInFrames} = useVideoConfig();
  const entry = registry[templateId];

  if (!entry) {
    return <Unknown id={templateId} />;
  }

  if (entry.type === 'render') {
    const Component = entry.component;
    return (
      <AbsoluteFill style={{backgroundColor: theme.palette.background}}>
        <Component data={props} theme={theme} timing={{fps, durationInFrames}} assets={resolveAssets(entry.manifest)} />
      </AbsoluteFill>
    );
  }

  // transition-kind: scene A → (transition) → scene B
  const half = Math.round((durationInFrames + TRANSITION_PREVIEW_OVERLAP) / 2);
  return (
    <TransitionSeries>
      <TransitionSeries.Sequence durationInFrames={half}>
        <PlaceholderCard label="A" bg={theme.palette.background} fg={theme.palette.accent} />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition
        presentation={entry.presentation(props)}
        timing={linearTiming({durationInFrames: TRANSITION_PREVIEW_OVERLAP})}
      />
      <TransitionSeries.Sequence durationInFrames={half}>
        <PlaceholderCard label="B" bg={theme.palette.accent} fg={theme.palette.background} />
      </TransitionSeries.Sequence>
    </TransitionSeries>
  );
};

// Preview durations (frames @ the composition fps). A render preview is a short
// loop; a transition preview is a touch longer so the blend is legible. The
// TransitionSeries total = ΣseqDur − overlap, so two `half` sequences minus the
// overlap reproduce PREVIEW_FRAMES.transition. Kept in sync via calculateMetadata.
export const TRANSITION_PREVIEW_OVERLAP = 20;
export const PREVIEW_FRAMES = {render: 45, transition: 70};
