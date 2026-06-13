'use client';

// Studio v3 M6 — VideoChrome: the editing-mode chrome + shared session context.
//
// This is the single home for the floating GateStepper bar (F3a) and the single
// source of truth for the session's gate state across the chrome and every gate
// page. It replaces the old layout.tsx markup (grid + rail + PiP) so the React
// context wraps children + PreviewRail + MobilePiP — the three surfaces T6 needs
// to coordinate the ≤2-player mount budget.
//
// Responsibilities:
//   • Poll /state once per navigation → expose {gates, autoRun, refresh}.
//   • Building-poll: while we've navigated to a gate whose row hasn't been
//     created yet (the classic "arrived at /script while the script stage is
//     still generating" case, ruling 2), poll every 2 s up to a cap so the
//     stepper + script page flip live the moment the gate opens.
//   • Mount the GateStepper on the four gate pages (current derived from the
//     pathname). The hub / running pages get no stepper.
//   • Provide openSceneIndex context for T6 (rail auto-pause + PiP unmount).
//
// The global Nav is hidden on /video/ routes (see Nav.tsx) so this bar is the
// editing-mode top chrome; the Topic ✦ step links Home, the GateHeader's back
// arrow links the hub.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import {usePathname, useRouter} from 'next/navigation';
import {cn} from '@/lib/cn';
import {studio, type GatesDict} from '@/lib/studio';
import {GateStepper} from './GateStepper';
import {PreviewRail} from './PreviewRail';
import {MobilePiP} from './MobilePiP';

type GateKey = 'script' | 'voice' | 'scenes' | 'assemble';
const GATE_KEYS: readonly GateKey[] = ['script', 'voice', 'scenes', 'assemble'];

/**
 * Pure helper (exported for tests): the current gate from a /video/[id]/<gate>
 * pathname, or null on the hub / running / any non-gate route.
 */
export function currentGateFromPath(pathname: string | null): GateKey | null {
  if (!pathname) return null;
  const seg = pathname.split('/')[3] ?? '';
  return (GATE_KEYS as readonly string[]).includes(seg) ? (seg as GateKey) : null;
}

// ─── shared session context ───────────────────────────────────────────────────

export interface VideoLayoutValue {
  gates: GatesDict;
  autoRun: boolean;
  /** Re-read /state — call after an approve/edit so the chrome reflects it. */
  refresh: () => Promise<void>;
  /** The scene row currently expanded in the Scenes accordion (T5/T6), else null. */
  openSceneIndex: number | null;
  setOpenSceneIndex: (n: number | null) => void;
}

const VideoLayoutContext = createContext<VideoLayoutValue>({
  gates: {},
  autoRun: false,
  refresh: async () => {},
  openSceneIndex: null,
  setOpenSceneIndex: () => {},
});

export function useVideoLayout(): VideoLayoutValue {
  return useContext(VideoLayoutContext);
}

// ─── building-poll cap ─────────────────────────────────────────────────────────
// The longest segment we'd arrive-into early is the script stage (~25-40 s).
// 120 s of 2 s polls is generous headroom; past that we stop and let the page
// show its own building/failed affordance rather than poll forever.
const POLL_INTERVAL_MS = 2000;
const POLL_CAP_MS = 120_000;

export function VideoChrome({id, children}: {id: string; children: React.ReactNode}) {
  const pathname = usePathname();
  const router = useRouter();

  const [gates, setGates] = useState<GatesDict>({});
  const [autoRun, setAutoRun] = useState(false);
  const [openSceneIndex, setOpenSceneIndex] = useState<number | null>(null);

  const current = currentGateFromPath(pathname);

  // Keep a ref to the freshest gates so the poll loop can read without re-binding.
  const gatesRef = useRef<GatesDict>(gates);
  gatesRef.current = gates;

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const st = await studio.session.state(id);
      setGates(st.gates ?? {});
      setAutoRun(!!st.autoRun);
    } catch {
      // session not found / transient — keep whatever we have.
    }
  }, [id]);

  // Refresh on mount + every navigation; drive the building-poll while the
  // current gate's row hasn't appeared yet.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const startedAt = Date.now();

    const tick = async () => {
      if (cancelled) return;
      await refresh();
      if (cancelled) return;
      const cur = currentGateFromPath(pathname);
      const ready = !cur || !!gatesRef.current[cur];
      const expired = Date.now() - startedAt > POLL_CAP_MS;
      if (!ready && !expired) {
        timer = setTimeout(tick, POLL_INTERVAL_MS);
      }
    };
    tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [pathname, refresh]);

  const toggleAutoRun = useCallback(
    async (b: boolean) => {
      setAutoRun(b); // optimistic
      try {
        await studio.session.setAutoRun(id, b);
      } catch {
        void refresh(); // revert to server truth on failure
      }
    },
    [id, refresh],
  );

  const navigate = useCallback(
    (gate: GateKey) => {
      router.push(`/video/${id}/${gate}`);
    },
    [id, router],
  );

  return (
    <VideoLayoutContext.Provider
      value={{gates, autoRun, refresh, openSceneIndex, setOpenSceneIndex}}
    >
      {current && (
        <GateStepper
          gates={gates}
          current={current}
          autoRun={autoRun}
          onToggleAutoRun={toggleAutoRun}
          onNavigate={navigate}
        />
      )}
      <main
        className={cn(
          'relative z-[1] mx-auto max-w-[1100px] px-4 pb-6',
          // Clear the fixed stepper bar (h-54 at top-3) on gate pages.
          current ? 'pt-[72px]' : 'pt-6',
        )}
      >
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
    </VideoLayoutContext.Provider>
  );
}
