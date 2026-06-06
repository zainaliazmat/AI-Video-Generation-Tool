import React from 'react';
import {AbsoluteFill} from 'remotion';
import type {TransitionPresentationComponentProps} from '@remotion/transitions';
import type {TransitionFactory} from '../sdk';

/**
 * `fade` transition presentation. The ENTERING scene fades 0->1 over the held
 * exiting scene (no mid-blend flash to background). Built from `remotion`
 * primitives only — the template carries no @remotion/transitions runtime dep,
 * just its types. <TransitionSeries> in the renderer drives presentationProgress.
 */
const Fade: React.FC<TransitionPresentationComponentProps<Record<string, unknown>>> = ({
  children,
  presentationDirection,
  presentationProgress,
}) => {
  const opacity = presentationDirection === 'entering' ? presentationProgress : 1;
  return <AbsoluteFill style={{opacity}}>{children}</AbsoluteFill>;
};

const presentation: TransitionFactory = () => ({
  component: Fade,
  props: {},
});

export default presentation;
