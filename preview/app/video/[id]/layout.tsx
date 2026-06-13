import {VideoChrome} from '@/components/VideoChrome';

// Studio v2 nested layout (PRD §8 Decision 1). The preview rail renders inside
// VideoChrome, so child gate routes (/script, /voice, /scenes, /assemble, the hub)
// swap inside the content pane while the rail/player survives navigation. Full
// reloads occur only entering/leaving the /video/[id] segment.
//
// v3 M6: VideoChrome (client) owns the floating GateStepper bar, the shared
// session-state context (gates/autoRun/openSceneIndex), and the grid + rail + PiP.
// The layout stays a thin server boundary that just resolves the sid.
export default async function VideoLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{id: string}>;
}) {
  const {id} = await params;
  return <VideoChrome id={id}>{children}</VideoChrome>;
}
