import {PreviewRail} from '@/components/PreviewRail';
import {MobilePiP} from '@/components/MobilePiP';

// Studio v2 nested layout (PRD §8 Decision 1). The preview rail renders HERE, so
// child gate routes (/script, /voice, /footage, /assemble, the hub) swap inside the
// content pane while the rail/player survives navigation. Full reloads occur only
// entering/leaving the /video/[id] segment. Below lg the rail is hidden and the
// floating MobilePiP (Decision 2A) is the persistent player instead.
export default async function VideoLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{id: string}>;
}) {
  const {id} = await params;
  return (
    <>
      <main className="relative z-[1] mx-auto max-w-[1100px] px-4 py-6">
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="min-w-0">{children}</div>
          <div className="hidden lg:block">
            <PreviewRail id={id} />
          </div>
        </div>
      </main>
      {/* OUTSIDE <main> on purpose: main is `relative z-[1]` (a stacking context),
          which would trap the fixed PiP/fullscreen under the nav's z-20. */}
      <MobilePiP id={id} />
    </>
  );
}
