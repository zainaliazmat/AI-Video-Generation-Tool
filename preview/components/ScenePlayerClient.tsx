'use client';

import dynamic from 'next/dynamic';
import type {Spec} from '@remotion-src/schema';

// next/dynamic with {ssr:false} can only be called inside a client component —
// this wrapper is that boundary. It guarantees the Player (and the Remotion
// composition it imports) only ever evaluates in the browser.
const ScenePlayerInner = dynamic(
  () => import('./ScenePlayer').then((m) => m.ScenePlayer),
  {
    ssr: false,
    loading: () => (
      <div className="aspect-[1080/1920] w-full animate-pulse-dot rounded-[var(--radius-md)] bg-white/[0.03]" />
    ),
  },
);

export function ScenePlayerClient({
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
  return (
    <ScenePlayerInner
      spec={spec}
      startFrame={startFrame}
      durationInFrames={durationInFrames}
      controls={controls}
    />
  );
}
