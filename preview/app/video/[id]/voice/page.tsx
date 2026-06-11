'use client';

import {useCallback, useEffect, useState} from 'react';
import {useParams} from 'next/navigation';
import {toast} from 'sonner';
import {studio, type Voice, type VoiceGate} from '@/lib/studio';
import {GateHeader, TintedButton} from '@/components/GateHeader';
import {Eyebrow, Badge} from '@/components/ui';
import {notifySpecChanged} from '@/components/PreviewRail';

// Studio v2 Voice gate (PRD §6.2). Kokoro voices, all local, all free — there is no
// premium/paywall UI by design. The single tinted action is Apply (in the header),
// which re-synthesizes narration and re-runs timing. Footage picks are preserved.
export default function VoicePage() {
  const params = useParams();
  const id = String(params.id);

  const [gate, setGate] = useState<VoiceGate | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [speed, setSpeed] = useState(1.0);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

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

  const preview = useCallback(
    async (voice: string) => {
      setPreviewing(voice);
      try {
        const res = await studio.voice.op(id, {op: 'preview', voice, speed});
        const audio = new Audio('/' + res.path);
        await audio.play();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'preview failed');
      } finally {
        setPreviewing(null);
      }
    },
    [id, speed],
  );

  const apply = useCallback(async () => {
    if (!selected || applying) return;
    setApplying(true);
    try {
      await studio.voice.op(id, {op: 'apply', voice: selected, speed});
      toast.success('Voice applied — narration re-synthesized and captions re-timed');
      notifySpecChanged();
      setGate((g) => (g ? {...g, current: {voice: selected, speed}} : g));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'apply failed');
    } finally {
      setApplying(false);
    }
  }, [id, selected, speed, applying]);

  return (
    <div>
      <GateHeader
        id={id}
        gate="voice"
        status={
          <span className="flex items-center gap-1.5">
            <Badge tone="green">Kokoro · local</Badge>
            <Badge tone="dim">all voices free</Badge>
          </span>
        }
        action={
          <TintedButton onClick={apply} disabled={!selected || applying}>
            {applying ? 'Applying…' : 'Apply'}
          </TintedButton>
        }
      />

      {applying ? (
        <div className="content-card mb-4 px-4 py-3 font-ui text-[13px] text-ink-secondary">
          Applying… re-synthesizing narration + re-timing captions — this can take a
          moment.
        </div>
      ) : null}

      {loadError ? (
        <div className="content-card px-4 py-8 text-center">
          <div className="font-ui text-[14px] font-semibold text-warn">
            Couldn’t load voices
          </div>
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
            <div
              key={i}
              className="content-card h-[120px] animate-pulse-dot p-4"
              aria-hidden
            />
          ))}
        </div>
      ) : (
        <>
          <div className="content-card mb-4 flex items-center gap-4 px-4 py-3">
            <label
              htmlFor="voice-speed"
              className="font-ui text-[13px] font-semibold text-ink"
            >
              Speed{' '}
              <span className="font-mono text-ink-secondary tabular-nums">
                {speed.toFixed(2)}×
              </span>
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

          <Eyebrow className="mb-2 px-1">Kokoro voices</Eyebrow>
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
                    (active
                      ? 'ring-2 ring-accent-1 bg-accent-1/[0.08]'
                      : 'hover:bg-white/[0.03]')
                  }
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-ui font-semibold text-ink">{v.name}</div>
                      <div className="mt-0.5 text-[13px] text-ink-secondary">
                        {v.character}
                      </div>
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
                    {busy ? 'synthesizing…' : '▶ Preview'}
                  </button>
                </div>
              );
            })}
          </div>

          <p className="mt-4 px-1 text-[13px] text-ink-muted">
            Applying re-synthesizes the narration and re-runs timing — word timestamps,
            scene durations, and short-clip loop math all re-derive. Footage picks are
            kept.
          </p>
        </>
      )}
    </div>
  );
}
