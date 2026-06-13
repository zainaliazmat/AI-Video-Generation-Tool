'use client';

import {useCallback, useEffect, useRef, useState} from 'react';
import Link from 'next/link';
import {useParams} from 'next/navigation';
import {toast} from 'sonner';
import {
  studio,
  type ScriptGate,
  type VoiceGate,
  type AssembleGate,
  type TimingGate,
  type TimingWord,
  type SessionState,
} from '@/lib/studio';
import {Eyebrow, Badge} from '@/components/ui';
import {notifySpecChanged} from '@/components/PreviewRail';
import {deriveGateCardState, isAssembleFrontier, type CardState} from '@/lib/gateCardState';

// Studio v3 Hub (PRD §5.1 / M6 T11) — the per-video control center.
//
// v3 additions:
//  - Fetches studio.session.state(id) for the GatesDict (alongside v2 reads).
//  - Gate cards speak v3 states: locked / building / approved / stale / reopened.
//  - "Footage" card renamed to "Scenes" (links to /video/[id]/scenes).
//  - Timing explainer row kept (§4 — not a gate).
//  - Frontier toast: when all gates approved + assemble awaiting → "Rebuilt — Assemble is ready →"
//  - Handles partial pre-spec gracefully (scenes:[] — hub still renders gate cards from gates).

type FootageScene = {provenance: {source: string} | null};
type FootageState = {scenes?: FootageScene[]};
type ProjectMeta = {spec?: {meta?: {title?: string}}};

// Map v3 CardState → Badge display
function cardStateBadge(state: CardState): React.ReactNode {
  switch (state) {
    case 'approved':
      return <Badge tone="green" dot>approved</Badge>;
    case 'stale':
      return <Badge tone="amber" dot>stale</Badge>;
    case 'reopened':
      return <Badge tone="amber" dot>reopened</Badge>;
    case 'building':
      return <Badge tone="blue" dot>building</Badge>;
    case 'locked':
      return <Badge tone="dim">locked</Badge>;
  }
}

function GateRow({
  href,
  label,
  desc,
  badge,
}: {
  href: string;
  label: string;
  desc: string;
  badge: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="content-card flex items-center gap-4 p-4 transition hover:bg-white/[0.03]"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2.5">
          <span className="font-ui text-[15px] font-semibold text-ink">{label}</span>
          {badge}
        </div>
        <p className="mt-0.5 font-ui text-[12.5px] text-ink-muted">{desc}</p>
      </div>
      <span className="shrink-0 text-ink-muted" aria-hidden>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 5l7 7-7 7" />
        </svg>
      </span>
    </Link>
  );
}

export default function HubPage() {
  const params = useParams();
  const id = String(params.id);

  const [script, setScript] = useState<ScriptGate | null>(null);
  const [voice, setVoice] = useState<VoiceGate | null>(null);
  const [footage, setFootage] = useState<FootageState | null>(null);
  const [assemble, setAssemble] = useState<AssembleGate | null>(null);
  const [project, setProject] = useState<ProjectMeta | null>(null);
  const [sessionState, setSessionState] = useState<SessionState | null>(null);
  const [loading, setLoading] = useState(true);

  // Track whether we've already fired the frontier toast this session.
  const frontierToastFired = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    // Tolerate individual gate failures: a stage that isn't built yet 404s. We settle
    // each independently and render whatever loaded.
    const [s, v, f, a, p, ss] = await Promise.allSettled([
      studio.script.read(id),
      studio.voice.list(id),
      studio.footage.state(id) as Promise<FootageState>,
      studio.assemble.read(id),
      studio.project(id) as Promise<ProjectMeta>,
      studio.session.state(id),
    ]);
    setScript(s.status === 'fulfilled' ? s.value : null);
    setVoice(v.status === 'fulfilled' ? v.value : null);
    setFootage(f.status === 'fulfilled' ? f.value : null);
    setAssemble(a.status === 'fulfilled' ? a.value : null);
    setProject(p.status === 'fulfilled' ? p.value : null);
    const ss2 = ss.status === 'fulfilled' ? ss.value : null;
    setSessionState(ss2);
    setLoading(false);

    // Frontier toast (ruling 4): fire once when all prior gates approved +
    // assemble is at awaiting_approval. Guard with a ref to avoid re-firing on
    // subsequent loads in the same page mount.
    if (ss2 && !frontierToastFired.current && isAssembleFrontier(ss2.gates)) {
      frontierToastFired.current = true;
      toast.success('Rebuilt — Assemble is ready →', {
        action: {
          label: 'Go',
          onClick: () => {
            window.location.href = `/video/${id}/assemble`;
          },
        },
        duration: 8000,
      });
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const title = project?.spec?.meta?.title || script?.title || 'Untitled video';

  // v3 gate card states from session gates dict
  const gates = sessionState?.gates ?? {};

  const scriptCardState = deriveGateCardState('script', gates);
  const voiceCardState = deriveGateCardState('voice', gates);
  const scenesCardState = deriveGateCardState('scenes', gates);
  const assembleCardState = deriveGateCardState('assemble', gates);

  // Script badge: prefer gate state badge; fall back to v2 unverified/supported
  // count if the session state isn't available yet (graceful degradation).
  const unverified = script ? script.beats.filter((b) => b.flag === 'unverified').length : 0;
  const scriptBadge = sessionState
    ? cardStateBadge(scriptCardState)
    : !script
    ? <Badge tone="dim">—</Badge>
    : unverified > 0
    ? <Badge tone="amber" dot>{unverified} unverified</Badge>
    : <Badge tone="green" dot>{script.factFloor.supported}/{script.factFloor.total} supported</Badge>;

  // Voice badge: prefer v3 gate state, fall back to v2 voice name
  const currentVoiceId = voice?.current?.voice ?? null;
  const voiceName =
    voice?.voices.find((vv) => vv.id === currentVoiceId)?.name ?? 'default';
  const voiceBadge = sessionState
    ? cardStateBadge(voiceCardState)
    : !voice
    ? <Badge tone="dim">—</Badge>
    : <Badge tone="blue">{voiceName}</Badge>;

  // Scenes badge: v3 gate state (renamed from Footage)
  const scenesBadge = sessionState
    ? cardStateBadge(scenesCardState)
    : !footage
    ? <Badge tone="dim">—</Badge>
    : (() => {
        const overridden = footage.scenes
          ? footage.scenes.filter((sc) => sc.provenance && sc.provenance.source !== 'auto').length
          : 0;
        return overridden > 0
          ? <Badge tone="purple">{overridden} overridden</Badge>
          : <Badge tone="dim">all auto</Badge>;
      })();

  // Assemble badge: v3 gate state, fall back to v2 spec-ready
  const assembleBadge = sessionState
    ? cardStateBadge(assembleCardState)
    : !assemble
    ? <Badge tone="dim">—</Badge>
    : <Badge tone="green">spec ready</Badge>;

  return (
    <div>
      {/* Title bar */}
      <div className="glass mb-4 flex items-center gap-3 rounded-[var(--radius-xl)] px-4 py-3">
        <div className="min-w-0">
          <Eyebrow className="mb-1">Editing hub</Eyebrow>
          <h1 className="truncate font-ui text-[18px] font-semibold tracking-tight text-ink">
            {title}
          </h1>
        </div>
        <Link
          href={`/video/${id}/assemble`}
          className="ml-auto shrink-0 rounded-full bg-accent-1 px-5 py-2 font-ui text-[13px] font-semibold text-white shadow-[0_6px_18px_rgba(94,92,230,0.4)] transition hover:brightness-110"
        >
          Render MP4 →
        </Link>
      </div>

      {/* Credibility banner */}
      {unverified > 0 && (
        <div className="mb-4 flex items-center gap-2 rounded-[var(--radius-lg)] border border-[rgba(245,158,11,0.3)] bg-[rgba(245,158,11,0.10)] px-4 py-3">
          <span className="text-warn">⚠</span>
          <span className="font-ui text-[13px] font-semibold text-warn">
            {unverified} unverified claim{unverified === 1 ? '' : 's'} — visible warn-and-ship
          </span>
        </div>
      )}

      {loading ? (
        <div className="space-y-2.5">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="content-card h-[68px] animate-pulse-dot" />
          ))}
        </div>
      ) : (
        <div className="space-y-2.5">
          <GateRow
            href={`/video/${id}/script`}
            label="Script"
            desc="Beats, facts, and sources — edit and re-verify."
            badge={scriptBadge}
          />
          <GateRow
            href={`/video/${id}/voice`}
            label="Voice"
            desc="Pick a narrator and speed — local, free Kokoro voices."
            badge={voiceBadge}
          />
          {/* v3 M6: "Footage" renamed to "Scenes", links to /scenes */}
          <GateRow
            href={`/video/${id}/scenes`}
            label="Scenes"
            desc="Swap, re-query, or upload the clip behind each scene."
            badge={scenesBadge}
          />
          <GateRow
            href={`/video/${id}/assemble`}
            label="Assemble"
            desc="Theme, transitions, and the final render."
            badge={assembleBadge}
          />

          <TimingExplainer id={id} />
        </div>
      )}
    </div>
  );
}

// Timing explainer (PRD §6.3) — NOT a gate, an expandable note plus a single control.
function TimingExplainer({id}: {id: string}) {
  const [open, setOpen] = useState(false);
  const [words, setWords] = useState<TimingWord[] | null>(null);
  const [loadingWords, setLoadingWords] = useState(false);
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const openModal = useCallback(async () => {
    setOpen(true);
    setEditIndex(null);
    if (words) return;
    setLoadingWords(true);
    try {
      const gate: TimingGate = await studio.timing.read(id);
      setWords(gate.words);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'failed to load transcript');
      setOpen(false);
    } finally {
      setLoadingWords(false);
    }
  }, [id, words]);

  async function submit(word: TimingWord) {
    const next = draft.trim();
    if (!next || next === word.text) {
      setEditIndex(null);
      return;
    }
    setSaving(true);
    try {
      const gate = await studio.timing.fixWord(id, word.index, next);
      setWords(gate.words);
      setEditIndex(null);
      notifySpecChanged();
      toast.success('Word fixed — captions updated');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'failed to fix word');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <details className="content-card overflow-hidden p-0 [&_summary]:list-none">
        <summary className="flex cursor-pointer items-center gap-2.5 p-4">
          <span className="font-ui text-[15px] font-semibold text-ink">Timing</span>
          <Badge tone="dim">deterministic alignment · not a gate</Badge>
        </summary>
        <div className="border-t border-white/[0.06] p-4">
          <p className="font-ui text-[13px] leading-relaxed text-ink-secondary">
            faster-whisper transcribes the generated voiceover into per-word timestamps that drive
            the karaoke captions and per-scene durations, pinning every scene to its narration frame
            at zero drift (seqDur = d + T). There is nothing to tune here — alignment is exact by
            construction.
          </p>
          <button
            onClick={openModal}
            className="mt-3 rounded-full bg-white/[0.07] px-4 py-2 font-ui text-[13px] font-semibold text-ink transition hover:bg-white/[0.12]"
          >
            Fix a word
          </button>
        </div>
      </details>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="glass flex max-h-[80vh] w-full max-w-[520px] flex-col rounded-[var(--radius-xl)] p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <Eyebrow>Fix a transcript word</Eyebrow>
              <button
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="flex h-7 w-7 items-center justify-center rounded-full text-ink-muted transition hover:bg-white/[0.06] hover:text-ink"
              >
                ×
              </button>
            </div>
            <p className="mb-3 font-ui text-[12px] text-ink-muted">
              Click a token to correct a mis-transcription. Frame timings are preserved.
            </p>

            {loadingWords ? (
              <p className="font-ui text-[13px] text-ink-muted">Loading transcript…</p>
            ) : !words || words.length === 0 ? (
              <p className="font-ui text-[13px] text-ink-muted">No transcript available yet.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5 overflow-y-auto">
                {words.map((w) =>
                  editIndex === w.index ? (
                    <input
                      key={w.index}
                      value={draft}
                      autoFocus
                      disabled={saving}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          submit(w);
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          setEditIndex(null);
                        }
                      }}
                      onBlur={() => submit(w)}
                      className="w-[7ch] rounded-[6px] border border-accent-1 bg-white/[0.06] px-2 py-1 font-mono text-[13px] text-ink outline-none"
                    />
                  ) : (
                    <button
                      key={w.index}
                      onClick={() => {
                        setEditIndex(w.index);
                        setDraft(w.text);
                      }}
                      disabled={saving}
                      className="rounded-[6px] bg-white/[0.05] px-2 py-1 font-mono text-[13px] text-ink-secondary transition hover:bg-white/[0.1] hover:text-ink disabled:opacity-50"
                    >
                      {w.text}
                    </button>
                  ),
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
