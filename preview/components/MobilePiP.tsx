'use client';

import {useCallback, useEffect, useState} from 'react';
import {PlayerClient} from './PlayerClient';
import {useVideoLayout} from './VideoChrome';
import {shouldMountPiP} from '@/lib/playerBudget';

// Mobile player — Decision 2A (locked mobile pattern; scheduling ratified in
// docs/superpowers/specs/2026-06-12-design-ratifications.md §5). Below lg the
// rail is `hidden`, which used to mean NO player at all on mobile. This is the
// locked pattern instead: a persistent floating PiP that survives gate-to-gate
// navigation (it lives in the /video/[id] layout, same trick as the rail), and
// tapping it opens the fullscreen "exactly what exports" view.
//
// Deliberately self-contained (own fetch + spec-changed listener, duplicated
// from PreviewRail) rather than sharing a hook — the rail is being reworked on
// a parallel branch and this file must not conflict with it.
export function MobilePiP({id}: {id: string}) {
  const [spec, setSpec] = useState<any>(null);
  const [fetchCount, setFetchCount] = useState(0);
  const [full, setFull] = useState(false);
  // T6 mount budget: the PiP unmounts while a scene row is open (the per-scene
  // player takes over on mobile), so we never mount two players at once.
  const {openSceneIndex} = useVideoLayout();

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${id}`, {cache: 'no-store'});
      const data = await res.json();
      if (!res.ok) return; // no player is better than a broken one on mobile
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

  // Esc closes fullscreen (hardware keyboards exist on tablets).
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
    <div className="lg:hidden">
      {!full ? (
        // Mini PiP: glass frame (floating control layer — layer discipline holds),
        // player chrome disabled so the single tap target is "go fullscreen".
        <button
          onClick={() => setFull(true)}
          aria-label="Open the video preview fullscreen"
          className="glass fixed bottom-4 right-4 z-40 w-[112px] rounded-[var(--radius-md)] p-1"
        >
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
