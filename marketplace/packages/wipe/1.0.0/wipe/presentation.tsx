import React from 'react';
import {AbsoluteFill} from 'remotion';
import type {TransitionPresentationComponentProps} from '@remotion/transitions';
import type {TransitionFactory} from '../sdk';

/**
 * wipe — directional clip-path wipe transition.
 *
 * The entering scene is revealed by a clip-path that expands from the leading
 * edge in the chosen direction. The exiting scene is left unchanged beneath it.
 *
 * Props:
 *   direction: "left" | "right" | "up" | "down" (default: "left")
 *
 * Runtime imports: react, remotion, @remotion/transitions (types only).
 */

type Direction = 'left' | 'right' | 'up' | 'down';
type P = {direction?: Direction};

function clipPath(direction: Direction, progress: number): string {
  // progress 0→1 reveals the entering scene fully from the leading edge.
  const pct = progress * 100;
  switch (direction) {
    case 'left':
      // Wipe from left: clip from right margin, shrinking inward
      return `inset(0 ${100 - pct}% 0 0)`;
    case 'right':
      // Wipe from right: clip from left margin, shrinking inward
      return `inset(0 0 0 ${100 - pct}%)`;
    case 'up':
      // Wipe from top: clip from bottom margin, shrinking upward
      return `inset(0 0 ${100 - pct}% 0)`;
    case 'down':
      // Wipe from bottom: clip from top margin, shrinking downward
      return `inset(${100 - pct}% 0 0 0)`;
  }
}

const WipeComponent: React.FC<TransitionPresentationComponentProps<P>> = ({
  children,
  presentationProgress,
  presentationDirection,
  passedProps,
}) => {
  const direction: Direction = (passedProps.direction as Direction) ?? 'left';

  // The entering scene is revealed by the clip-path wipe.
  // The exiting scene slides out unclipped.
  if (presentationDirection === 'entering') {
    return (
      <AbsoluteFill style={{clipPath: clipPath(direction, presentationProgress)}}>
        {children}
      </AbsoluteFill>
    );
  }

  // Exiting: sit still while entering scene wipes over it.
  return <AbsoluteFill>{children}</AbsoluteFill>;
};

const presentation: TransitionFactory = (props) => ({
  component: WipeComponent,
  props: {direction: (props?.direction as Direction) ?? 'left'},
});

export default presentation;
