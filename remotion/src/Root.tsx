import React from 'react';
import {
  Composition,
  staticFile,
  type CalculateMetadataFunction,
} from 'remotion';
import {Video} from './Video';
import type {Spec} from './schema';

// The spec.json is served from remotion/public/ (the `copy-spec` npm script
// copies the repo-root spec there before studio/render). Loading it via
// staticFile()+fetch avoids a fragile cross-root JSON import and lets us swap
// the spec without rebundling.
const SPEC_PUBLIC_PATH = 'spec.json';

type RootProps = {
  spec: Spec;
};

// calculateMetadata may be async and runs before the component in BOTH studio
// and CLI render. It reads the spec and drives the composition's real
// dimensions/duration (the static props below are just the pre-resolution
// placeholder the type system requires).
const calculateMetadata: CalculateMetadataFunction<RootProps> = async ({
  abortSignal,
}) => {
  const res = await fetch(staticFile(SPEC_PUBLIC_PATH), {signal: abortSignal});
  if (!res.ok) {
    throw new Error(
      `Could not load spec "${SPEC_PUBLIC_PATH}" from public/ (HTTP ${res.status}). ` +
        `Run via "npm run render" / "npm run studio" so the copy-spec step stages it, ` +
        `or run "npm run copy-spec" first.`,
    );
  }
  const spec = (await res.json()) as Spec;

  return {
    durationInFrames: spec.meta.durationInFrames,
    fps: spec.meta.fps,
    width: spec.meta.width,
    height: spec.meta.height,
    props: {spec},
  };
};

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="Video"
      component={Video}
      // Placeholder values — overridden by calculateMetadata at runtime.
      durationInFrames={1}
      fps={30}
      width={1080}
      height={1920}
      defaultProps={{spec: undefined as unknown as Spec}}
      calculateMetadata={calculateMetadata}
    />
  );
};
