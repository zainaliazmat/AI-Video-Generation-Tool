import React from 'react';
import {AbsoluteFill, interpolate} from 'remotion';
import type {TransitionPresentationComponentProps} from '@remotion/transitions';
import type {TransitionFactory} from '../sdk';

type Direction = 'from-left' | 'from-right' | 'from-top' | 'from-bottom';

/**
 * `slide` transition presentation. The entering scene slides in from
 * `props.direction` while the exiting scene slides out the opposite way. Reads
 * its direction from scene.transition.props (passedProps). remotion-only runtime.
 */
const Slide: React.FC<TransitionPresentationComponentProps<Record<string, unknown>>> = ({
  children,
  presentationDirection,
  presentationProgress,
  passedProps,
}) => {
  const dir = ((passedProps.direction as Direction) ?? 'from-right') as Direction;
  const axis = dir === 'from-top' || dir === 'from-bottom' ? 'Y' : 'X';
  const sign = dir === 'from-left' || dir === 'from-top' ? -1 : 1;
  const offset =
    presentationDirection === 'entering'
      ? interpolate(presentationProgress, [0, 1], [sign * 100, 0])
      : interpolate(presentationProgress, [0, 1], [0, -sign * 100]);
  return (
    <AbsoluteFill style={{transform: `translate${axis}(${offset}%)`}}>{children}</AbsoluteFill>
  );
};

const presentation: TransitionFactory = (props) => ({
  component: Slide,
  props: {direction: (props?.direction as Direction) ?? 'from-right'},
});

export default presentation;
