'use client';

import {useCallback, useEffect, useState} from 'react';
import {PlayerClient} from './PlayerClient';
import {useVideoLayout} from './VideoChrome';
import {shouldMountPiP} from '@/lib/playerBudget';

// FloatingPiP — the persistent floating preview (PRD §8 "nested-layout trick":
// lives in the /video/[id] layout so it survives gate-to-gate navigation).
// Originally mobile-only; now the editing-gate preview on ALL viewports — the
// fixed 300px "Live preview" rail is reserved for the Assemble gate, where the
// full assembly is the point. A mini thumbnail floats bottom-right; tapping it
// opens the fullscreen "exactly what exports" view.
//
// `hideOnDesktop` (set on the Assemble gate) collapses it to mobile-only via
// `lg:hidden` so it doesn't double up with the desktop rail there.
//
// Mount budget (lib/playerBudget): unmounts while a scene row is open (the
// per-scene player takes over), so at most one @remotion/player is mounted.
export function FloatingPiP({id, hideOnDesktop = false}: {id: string; hideOnDesktop?: boolean}) {
  const [spec, setSpec] = useState<any>(null);
  const [fetchCount, setFetchCount] = useState(0);
  const [full, setFull] = useState(false);
  const {openSceneIndex} = useVideoLayout();

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${id}`, {cache: 'no-store'});
      const data = await res.json();
      if (!res.ok) return; // no player is better than a broken one
      setSpec(data.spec);
      setFetchCount((v) => v + 1);
    } catch {
      /* keep the previous spec, if any */
    }
  }, [id]);

  useEffect(() => {
    load();
    const onChange = () => load();
    window.addEventListener('studio:spec-changed', onChange);
    return () => window.removeEventListener('studio:spec-changed', onChange);
  }, [load]);

  // Lock page scroll behind the fullscreen view.
  useEffect(() => {
    if (!full) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [full]);

  // Esc closes fullscreen (hardware keyboards exist on tablets + desktop).
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFull(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full]);

  if (!spec) return null;
  // Unmount entirely while a scene row is open (mount-budget partner is the
  // per-scene player). Closing the fullscreen view first avoids a stuck overlay.
  if (!shouldMountPiP(openSceneIndex)) return null;

  return (
    <div className={hideOnDesktop ? 'lg:hidden' : undefined}>
      {!full ? (
        // Mini PiP: glass frame, a thin label so a floating thumbnail reads as a
        // preview (esp. on desktop), then the player. The whole card is one tap
        // target = "go fullscreen"; player chrome stays disabled.
        <button
          onClick={() => setFull(true)}
          aria-label="Open the video preview fullscreen"
          className="glass fixed bottom-4 right-4 z-40 w-[120px] overflow-hidden rounded-[var(--radius-md)] p-1 transition hover:brightness-110 lg:w-[150px]"
        >
          <div className="flex items-center justify-between px-1 pb-1 pt-0.5">
            <span className="font-ui text-[10px] font-semibold text-ink-secondary">Preview</span>
            <ExpandIcon />
          </div>
          <div className="pointer-events-none overflow-hidden rounded-[8px] border border-white/10 bg-black">
            <PlayerClient key={fetchCount} spec={spec} controls={false} />
          </div>
        </button>
      ) : (
        <div className="fixed inset-0 z-50 flex flex-col bg-black/85">
          <div className="glass m-3 flex items-center justify-between rounded-full px-4 py-2">
            <span className="font-ui text-[12px] font-semibold text-ink">
              Preview · exactly what exports
            </span>
            <button
              onClick={() => setFull(false)}
              aria-label="Close fullscreen preview"
              className="rounded-full bg-white/[0.08] px-3 py-1 font-ui text-[13px] font-semibold text-ink transition hover:bg-white/[0.14]"
            >
              ✕
            </button>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center px-4 pb-4">
            <div
              className="overflow-hidden rounded-[var(--radius-md)] border border-white/10 bg-black"
              style={{
                // 9:16 sized by whichever constraint binds — full height, or full
                // width on very narrow screens; width follows from aspect-ratio.
                height: 'min(100%, calc((100vw - 32px) * 1920 / 1080))',
                aspectRatio: '1080 / 1920',
              }}
            >
              <PlayerClient key={`full-${fetchCount}`} spec={spec} />
            </div>
          </div>
          <p className="pb-3 text-center font-ui text-[11px] text-ink-muted">
            Same spec, same renderer as the export — what you approve here is what renders.
          </p>
        </div>
      )}
    </div>
  );
}

const ExpandIcon = () => (
  <svg
    className="h-3 w-3 text-ink-muted"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
  </svg>
);
