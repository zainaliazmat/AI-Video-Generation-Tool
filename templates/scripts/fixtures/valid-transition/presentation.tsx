import React from 'react';
import {AbsoluteFill} from 'remotion';
import type {TransitionPresentation, TransitionPresentationComponentProps} from '@remotion/transitions';

type P = Record<string, unknown>;
const Presentation: React.FC<TransitionPresentationComponentProps<P>> = ({children, presentationProgress, presentationDirection}) => {
  const reveal = presentationDirection === 'entering' ? presentationProgress : 1;
  return (
    <AbsoluteFill style={{clipPath: presentationDirection === 'entering' ? `inset(0 ${(1 - reveal) * 100}% 0 0)` : undefined}}>
      {children}
    </AbsoluteFill>
  );
};
const factory = (_props?: P): TransitionPresentation<P> => ({component: Presentation, props: {}});
export default factory;
