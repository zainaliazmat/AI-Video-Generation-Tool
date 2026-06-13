'use client';

import {useCallback, useEffect, useRef, useState} from 'react';
import Link from 'next/link';
import {useParams, useRouter} from 'next/navigation';
import {toast} from 'sonner';
import {studio, frontierGate, type Voice, type VoiceGate, type GatesDict} from '@/lib/studio';
import {GateHeader, TintedButton} from '@/components/GateHeader';
import {GateInterstitial, type GateTask} from '@/components/GateInterstitial';
import {StatefulStamp} from '@/components/StatefulStamp';
import {useVideoLayout} from '@/components/VideoChrome';
import {notifySpecChanged} from '@/components/PreviewRail';
import {Eyebrow, Badge} from '@/components/ui';

// Studio v3 Voice gate (PRD §6.2, M6-T4). Kokoro voices, all local + free.
//
// v3 changes from v2:
//   • Preview plays YOUR beat 1 (the M3 preview op synthesizes the real first
//     beat via --sid, which the route passes unconditionally). The returned path
//     is stable per (voice, speed) — we cache it client-side and reuse on replay,
//     synthesizing (spinner) only on first play (M3 amend 4).
//   • Approve is the gate's one tinted action → studio.session.approve(id,'voice',
//     {voice,speed}) SSE → the HEAVY interstitial (voice→timing→footage→assemble),
//     then navigate to the scenes frontier. This replaces v2's synchronous Apply.
//   • Gate copy replaced per ruling 18 — the false v2 "footage picks are kept"
//     line is gone (this is the segment that BUILDS footage).

// The heavy voice→scenes segment, in order (gates.GATE_SEGMENTS.scenes).
const APPROVE_TASKS: GateTask[] = [
  {key: 'voice', label: 'Synthesizing narration'},
  {key: 'timing', label: 'Word-by-word timing'},
  {key: 'footage', label: 'Fetching footage pools'},
  {key: 'assemble', label: 'Assembling the first cut'},
];

function isReopened(g: GatesDict['voice']): boolean {
  if (!g) return false;
  return g.state === 'reopened' || (g.state === 'awaiting_approval' && g.approved_at != null);
}

export default function VoicePage() {
  const params = useParams();
  const id = String(params.id);
  const router = useRouter();

  const {gates, autoRun} = useVideoLayout();
  const voiceGate = gates.voice;
  const gateApproved = voiceGate?.state === 'approved';
  const reopened = isReopened(voiceGate);

  const [gate, setGate] = useState<VoiceGate | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [speed, setSpeed] = useState(1.0);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);

  // Cache the synthesized preview path per (voice, speed) so replays don't re-POST
  // (the path is stable per M3 amend 4). A speed change yields fresh keys.
  const pathCache = useRef<Map<string, string>>(new Map());
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const data = await studio.voice.list(id);
      setGate(data);
      const def = data.current?.voice ?? data.voices[0]?.id ?? null;
      setSelected(def);
      setSpeed(data.current?.speed ?? 1.0);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'failed to load voices');
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // Stop any playing audio on unmount.
  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, []);

  const preview = useCallback(
    async (voice: string) => {
      const key = `${voice}@${speed.toFixed(2)}`;
      // Stop whatever is playing first.
      audioRef.current?.pause();

      const cached = pathCache.current.get(key);
      const playPath = (path: string) => {
        const audio = new Audio('/' + path);
        audioRef.current = audio;
        void audio.play().catch(() => {/* autoplay/codec — ignore */});
      };

      if (cached) {
        playPath(cached);
        return;
      }

      setPreviewing(voice);
      try {
        const res = await studio.voice.op(id, {op: 'preview', voice, speed});
        if (res?.path) {
          pathCache.current.set(key, res.path);
          playPath(res.path);
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'preview failed');
      } finally {
        setPreviewing(null);
      }
    },
    [id, speed],
  );

  function onApprove() {
    if (!selected) return;
    setApproving(true);
  }

  // ── approving: the heavy interstitial replaces the page body ────────────────
  if (approving && selected) {
    return (
      <div>
        <GateHeader id={id} gate="voice" gates={gates} />
        <GateInterstitial
          stream={() => studio.session.approve(id, 'voice', {voice: selected, speed})}
          tasks={APPROVE_TASKS}
          sid={id}
          leaveCopy="~a few minutes — one footage pool per beat; you can leave, it keeps building"
          onDone={(doneGates?: GatesDict) => {
            notifySpecChanged(); // the heavy segment built footage + the first cut
            const next = (doneGates && frontierGate(doneGates)) ?? 'scenes';
            router.push(`/video/${id}/${next}`);
          }}
        />
      </div>
    );
  }

  // ── locked: the script hasn't been approved yet (voice gate not opened) ──────
  if (!voiceGate && gate) {
    return (
      <div>
        <GateHeader id={id} gate="voice" gates={gates} />
        <div className="content-card p-6 text-center">
          <Eyebrow className="mb-2">Voice is locked</Eyebrow>
          <p className="font-ui text-[13px] text-ink-secondary">
            Approve the script first — the voice gate opens once the script is locked.
          </p>
          <Link
            href={`/video/${id}/script`}
            className="mt-4 inline-block rounded-full bg-accent-1 px-5 py-2 font-ui text-[13px] font-semibold text-white shadow-[0_6px_18px_rgba(94,92,230,0.4)] transition hover:brightness-110"
          >
            Go to Script →
          </Link>
        </div>
      </div>
    );
  }

  // Tinted action: hidden once approved (view-only until T9's reopen-on-edit);
  // amber Re-approve when the gate was reopened.
  const action = !gate ? undefined : gateApproved ? (
    <span className="rounded-full bg-white/[0.06] px-4 py-2 font-ui text-[13px] font-semibold text-ink-muted">
      Approved ✓
    </span>
  ) : (
    <TintedButton onClick={onApprove} disabled={!selected} variant={reopened ? 'amber' : 'indigo'}>
      {reopened ? 'Re-approve' : autoRun ? 'Approve & run all' : 'Approve'}
    </TintedButton>
  );

  return (
    <div>
      <GateHeader
        id={id}
        gate="voice"
        gates={gates}
        status={
          <span className="flex items-center gap-1.5">
            <Badge tone="green">Kokoro · local</Badge>
            <Badge tone="dim">all voices free</Badge>
          </span>
        }
        action={action}
      />

      {/* Stateful stamp (§4.1.1). */}
      {voiceGate && <div className="content-card mb-4 px-4 py-3"><StatefulStamp gate="voice" gateState={voiceGate} /></div>}

      {loadError ? (
        <div className="content-card px-4 py-8 text-center">
          <div className="font-ui text-[14px] font-semibold text-warn">Couldn’t load voices</div>
          <div className="mt-1 font-mono text-[12px] text-ink-muted">{loadError}</div>
          <button
            type="button"
            onClick={load}
            className="mt-4 rounded-full bg-white/[0.07] px-4 py-2 font-ui text-[13px] font-semibold text-ink transition hover:bg-white/[0.12]"
          >
            Retry
          </button>
        </div>
      ) : !gate ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({length: 6}).map((_, i) => (
            <div key={i} className="content-card h-[120px] animate-pulse-dot p-4" aria-hidden />
          ))}
        </div>
      ) : (
        <>
          <div className="content-card mb-4 flex items-center gap-4 px-4 py-3">
            <label htmlFor="voice-speed" className="font-ui text-[13px] font-semibold text-ink">
              Speed{' '}
              <span className="font-mono text-ink-secondary tabular-nums">{speed.toFixed(2)}×</span>
            </label>
            <input
              id="voice-speed"
              type="range"
              min={0.8}
              max={1.2}
              step={0.05}
              value={speed}
              onChange={(e) => setSpeed(parseFloat(e.target.value))}
              className="h-1.5 flex-1 cursor-pointer accent-accent-1"
            />
          </div>

          <Eyebrow className="mb-2 px-1">Kokoro voices · plays your beat 1</Eyebrow>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {gate.voices.map((v: Voice) => {
              const active = selected === v.id;
              const busy = previewing === v.id;
              return (
                <div
                  key={v.id}
                  role="button"
                  tabIndex={0}
                  aria-pressed={active}
                  onClick={() => setSelected(v.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelected(v.id);
                    }
                  }}
                  className={
                    'content-card cursor-pointer p-4 transition ' +
                    (active ? 'ring-2 ring-accent-1 bg-accent-1/[0.08]' : 'hover:bg-white/[0.03]')
                  }
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-ui font-semibold text-ink">{v.name}</div>
                      <div className="mt-0.5 text-[13px] text-ink-secondary">{v.character}</div>
                    </div>
                    <Badge tone="dim">{v.lang}</Badge>
                  </div>
                  <div className="mt-2 font-mono text-[11px] text-ink-muted">{v.id}</div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!busy) preview(v.id);
                    }}
                    disabled={busy}
                    className="mt-3 rounded-full bg-white/[0.07] px-3 py-1.5 font-ui text-[12px] font-semibold text-ink transition hover:bg-white/[0.12] disabled:opacity-60"
                  >
                    {busy ? 'synthesizing…' : '♪ Play your beat 1'}
                  </button>
                </div>
              );
            })}
          </div>

          {/* Gate copy (ruling 18) — replaces the false v2 "footage picks are kept" line.
              This IS the segment that builds narration → timing → footage → first cut. */}
          <p className="mt-4 px-1 text-[13px] leading-relaxed text-ink-muted">
            Approve locks the voice, then builds narration, timing, footage, and a first
            assembly — a few minutes. The speed slider re-times everything: word timestamps,
            scene durations, and short-clip loop math all re-derive from the new narration.
          </p>
        </>
      )}
    </div>
  );
}
