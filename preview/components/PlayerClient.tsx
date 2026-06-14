'use client';

import dynamic from 'next/dynamic';
import type {Spec} from '@remotion-src/schema';

// next/dynamic with {ssr:false} can only be called inside a client component —
// this wrapper is that boundary. It guarantees the Player (and the Remotion
// composition it imports) only ever evaluates in the browser.
const VideoPlayer = dynamic(() => import('./VideoPlayer').then((m) => m.VideoPlayer), {
  ssr: false,
  loading: () => (
    <div className="aspect-[1080/1920] w-full animate-pulse-dot rounded-[var(--radius-md)] bg-white/[0.03]" />
  ),
});

export function PlayerClient({
  spec,
  controls = true,
  paused = false,
  playSignal = 0,
}: {
  spec: Spec;
  controls?: boolean;
  paused?: boolean;
  playSignal?: number;
}) {
  return <VideoPlayer spec={spec} controls={controls} paused={paused} playSignal={playSignal} />;
}
