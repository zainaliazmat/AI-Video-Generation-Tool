'use client';

// Studio v3 M6 — Scenes gate (scene-major accordion). T5 shell + arrival, T6
// per-scene player + mount budget, T7 controls column.
//
//   • One row per scene, ONE open at a time (openSceneIndex in the VideoChrome
//     context, so the rail auto-pauses + the mobile PiP unmounts — T6 budget).
//   • Collapsed row: index · kind chip · truncated beat · duration · two
//     StatusPills (MEDIA + TEMPLATE) · chevron (≥44px).
//   • Arrival (ruling 12): all collapsed, the rail plays the full first assembly
//     once from frame 0, a one-time eyebrow announces it. No modal/confetti.
//   • Open row: ScenePlayer bound to the scene's [startFrame, +duration] span +
//     the controls column (template chips, footage/background pools, transition
//     chips, suggest/re-query/upload, provenance popover, under-player strip).

import {useCallback, useEffect, useRef, useState} from 'react';
import Link from 'next/link';
import {useParams} from 'next/navigation';
import {toast} from 'sonner';
import {studio, type SceneState, type GatesDict} from '@/lib/studio';
import type {Spec} from '@remotion-src/schema';
import {useRouter} from 'next/navigation';
import {GateHeader, TintedButton} from '@/components/GateHeader';
import {GateInterstitial, type GateTask} from '@/components/GateInterstitial';
import {StatefulStamp} from '@/components/StatefulStamp';
import {StatusPills} from '@/components/StatusPills';
import {ScenePlayerClient} from '@/components/ScenePlayerClient';
import {useEditIntent} from '@/components/EditIntent';
import {useVideoLayout} from '@/components/VideoChrome';
import {notifySpecChanged, notifyRailPlay} from '@/components/PreviewRail';
import {frontierGate} from '@/lib/studio';
import {Eyebrow, Badge} from '@/components/ui';
import {SceneControls} from '@/components/scenes/SceneControls';

function isReopenedGate(g: {state: string; approved_at: string | null} | undefined): boolean {
  if (!g) return false;
  return g.state === 'reopened' || (g.state === 'awaiting_approval' && g.approved_at != null);
}

const REAPPROVE_TASKS: GateTask[] = [
  {key: 'voice', label: 'Re-synthesizing narration'},
  {key: 'timing', label: 'Word timing'},
  {key: 'footage', label: 'Footage'},
  {key: 'assemble', label: 'Re-assembling'},
];

// Module-level guard so the arrival auto-play fires once per sid per session.
const arrivedSids = new Set<string>();

type Kind = 'Hook' | 'Outro' | 'Stat' | 'Scene' | string;
function kindLabel(scene: SceneState, total: number): Kind {
  const t = scene.template;
  if (t === 'hook') return 'Hook';
  if (t === 'outro') return 'Outro';
  if (t === 'stat') return 'Stat';
  if (scene.index === 0) return 'Hook';
  if (scene.index === total - 1) return 'Outro';
  return 'Scene';
}

function fmtDuration(frames: number | null, fps: number): string {
  if (!frames) return '—';
  return `${(frames / fps).toFixed(1)}s`;
}

export default function ScenesPage() {
  const params = useParams<{id: string}>();
  const id = params.id;

  const router = useRouter();
  const {gates, openSceneIndex, setOpenSceneIndex, refresh} = useVideoLayout();
  const scenesGate = gates.scenes;
  const gateReady = !!scenesGate;
  const reopened = isReopenedGate(scenesGate);

  const [scenes, setScenes] = useState<SceneState[]>([]);
  const [spec, setSpec] = useState<Spec | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reapproving, setReapproving] = useState(false);

  // T9 §4.1: at an APPROVED scenes gate, the first pool/template edit opens the
  // blast-radius sheet; Reopen fires the withheld POST (gatekeeper defers + reopens).
  const {intend, sheet} = useEditIntent({sid: id, gate: 'scenes', gateState: scenesGate});

  const loadState = useCallback(async () => {
    try {
      const [st, project] = await Promise.all([
        studio.session.state(id),
        studio.project(id).catch(() => null),
      ]);
      setScenes(Array.isArray(st?.scenes) ? st.scenes : []);
      setSpec((project?.spec as Spec) ?? null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load scenes gate');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  // Arrival (ruling 12): once the scenes gate is real + a spec exists, collapse
  // everything and play the rail once from frame 0. Guarded to fire once per sid.
  useEffect(() => {
    if (gateReady && spec && !arrivedSids.has(id)) {
      arrivedSids.add(id);
      setOpenSceneIndex(null);
      // Defer so the rail player has mounted before we ask it to play.
      const t = setTimeout(() => notifyRailPlay(), 400);
      return () => clearTimeout(t);
    }
  }, [gateReady, spec, id, setOpenSceneIndex]);

  // Collapse any open row when leaving the page (restore the rail/PiP budget).
  useEffect(() => {
    return () => setOpenSceneIndex(null);
  }, [setOpenSceneIndex]);

  // Re-fetch authoritative state + spec after an edit, then refresh the rail.
  const afterEdit = useCallback(async () => {
    await loadState();
    notifySpecChanged();
    void refresh(); // an edit at an approved gate may reopen it
  }, [loadState, refresh]);

  // ── locked: the voice gate hasn't been approved, so no scenes/spec yet ──────
  if (!loading && !gateReady) {
    return (
      <div>
        <GateHeader id={id} gate="scenes" gates={gates} />
        <div className="content-card p-6 text-center">
          <Eyebrow className="mb-2">Scenes are locked</Eyebrow>
          <p className="font-ui text-[13px] text-ink-secondary">
            Approve Voice to build scenes — narration, timing, and footage pools assemble the
            first cut.
          </p>
          <Link
            href={`/video/${id}/voice`}
            className="mt-4 inline-block rounded-full bg-accent-1 px-5 py-2 font-ui text-[13px] font-semibold text-white shadow-[0_6px_18px_rgba(94,92,230,0.4)] transition hover:brightness-110"
          >
            Go to Voice →
          </Link>
        </div>
      </div>
    );
  }

  // ── re-approving: the rederive interstitial replaces the accordion ──────────
  if (reapproving) {
    return (
      <div>
        <GateHeader id={id} gate="scenes" gates={gates} />
        <GateInterstitial
          stream={() => studio.session.approve(id, 'scenes')}
          tasks={REAPPROVE_TASKS}
          sid={id}
          leaveCopy="rebuilding the stale steps once — you can leave, it keeps running"
          onDone={(doneGates?: GatesDict) => {
            // Ruling 4: stay on the reopened gate; toast links the frontier.
            notifySpecChanged();
            setReapproving(false);
            void afterEdit();
            const next = doneGates && frontierGate(doneGates);
            if (next) {
              const label = next.charAt(0).toUpperCase() + next.slice(1);
              toast.success(`Rebuilt — ${label} is ready →`, {
                action: {label: 'Go', onClick: () => router.push(`/video/${id}/${next}`)},
                duration: 8000,
              });
            }
          }}
        />
      </div>
    );
  }

  const total = scenes.length;
  const fps = spec?.meta.fps ?? 30;
  const justArrived = openSceneIndex === null && arrivedSids.has(id);
  const reapproveAction = reopened ? (
    <TintedButton onClick={() => setReapproving(true)} variant="amber">
      Re-approve
    </TintedButton>
  ) : undefined;

  return (
    <div>
      {sheet}
      <GateHeader
        id={id}
        gate="scenes"
        gates={gates}
        status={scenesGate ? <Badge tone="purple" dot>{total} scenes</Badge> : null}
        action={reapproveAction}
      />

      {scenesGate && (
        <div className="content-card mb-4 px-4 py-3">
          <StatefulStamp gate="scenes" gateState={scenesGate} sceneCount={scenes.filter((s) => s.needsFootage).length} totalCount={total} />
        </div>
      )}

      {/* Arrival eyebrow — one-time (ruling 12). The celebration is the video itself. */}
      {justArrived && total > 0 && (
        <div className="mb-4 flex items-center gap-2 rounded-[var(--radius-md)] bg-white/[0.04] px-4 py-2.5">
          <span className="text-[#30d158]" aria-hidden>✦</span>
          <span className="font-ui text-[12.5px] font-medium text-ink-secondary">
            first assembly ready — every scene is editable below
          </span>
        </div>
      )}

      {/* Reopened: edits are deferred (ruling OV-12). Picks show a pending pill and
          the per-scene player keeps the old clip until ONE Re-approve pays. */}
      {reopened && (
        <div className="mb-4 flex items-center gap-2 rounded-[var(--radius-md)] bg-warn-soft px-4 py-2.5">
          <span className="text-warn" aria-hidden>●</span>
          <span className="font-ui text-[12.5px] font-medium text-warn">
            edits pending — they apply on Re-approve; the players keep the current clips until then
          </span>
        </div>
      )}

      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="content-card h-[58px] animate-pulse-dot" />
          ))}
        </div>
      ) : error ? (
        <div className="content-card p-5 font-ui text-[13px] text-warn">{error}</div>
      ) : total === 0 ? (
        <div className="content-card p-5 font-ui text-[13px] text-ink-muted">
          No scenes in this video yet.
        </div>
      ) : (
        <div className="space-y-2" role="list">
          {scenes.map((scene) => (
            <SceneRow
              key={scene.index}
              sid={id}
              scene={scene}
              spec={spec}
              fps={fps}
              total={total}
              open={openSceneIndex === scene.index}
              busy={busy}
              setBusy={setBusy}
              reopened={reopened}
              intend={intend}
              gateState={scenesGate}
              onToggle={() =>
                setOpenSceneIndex(openSceneIndex === scene.index ? null : scene.index)
              }
              onChanged={afterEdit}
              kind={kindLabel(scene, total)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── one accordion row ──────────────────────────────────────────────────────

function SceneRow({
  sid,
  scene,
  spec,
  fps,
  total,
  open,
  busy,
  setBusy,
  reopened,
  intend,
  gateState,
  onToggle,
  onChanged,
  kind,
}: {
  sid: string;
  scene: SceneState;
  spec: Spec | null;
  fps: number;
  total: number;
  open: boolean;
  busy: boolean;
  setBusy: (b: boolean) => void;
  reopened: boolean;
  intend: (apply: () => void | Promise<void>) => void;
  gateState: GatesDict['scenes'];
  onToggle: () => void;
  onChanged: () => Promise<void>;
  kind: Kind;
}) {
  const beat = scene.beatText?.trim() || '(no beat text)';
  const specScene = spec?.scenes?.[scene.index] ?? null;
  const regionId = `scene-body-${scene.index}`;

  return (
    <div className="content-card overflow-hidden p-0" role="listitem">
      {/* Collapsed header row — the toggle button (≥44px touch target). */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={regionId}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-white/[0.03]"
      >
        <span className="font-mono text-[11px] text-ink-muted tabular-nums">
          {String(scene.index + 1).padStart(2, '0')}
        </span>
        <Badge tone={kind === 'Stat' ? 'blue' : kind === 'Hook' || kind === 'Outro' ? 'purple' : 'dim'}>
          {kind}
        </Badge>
        <span className="min-w-0 flex-1 truncate font-ui text-[13px] text-ink-secondary" title={beat}>
          {beat}
        </span>
        <span className="hidden font-mono text-[11px] text-ink-muted tabular-nums sm:inline">
          {fmtDuration(scene.durationInFrames, fps)}
        </span>
        <StatusPills scene={scene} />
        <span
          className={`flex h-6 w-6 flex-none items-center justify-center text-ink-muted transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
          aria-hidden
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 5l7 7-7 7" /></svg>
        </span>
      </button>

      {/* Body — lazy-mounted only when open (mount budget: at most one scene
          player). aria-expanded on the button reflects collapsed state for SRs. */}
      {open && (
        <div id={regionId} className="border-t border-white/[0.06] p-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
            {/* Per-scene player (T6) — bound to the scene's span on the live spec. */}
            <div className="min-w-0">
              <div className="overflow-hidden rounded-[var(--radius-md)] border border-white/10 bg-black">
                {specScene ? (
                  <ScenePlayerClient
                    spec={spec!}
                    startFrame={specScene.startFrame}
                    durationInFrames={specScene.durationInFrames}
                    controls
                  />
                ) : (
                  <div className="aspect-[1080/1920] w-full animate-pulse-dot bg-white/[0.03]" />
                )}
              </div>
              <UnderPlayerStrip sid={sid} scene={scene} specScene={specScene} fps={fps} />
            </div>

            {/* Controls column (T7). */}
            <SceneControls
              sid={sid}
              scene={scene}
              total={total}
              fps={fps}
              specScene={specScene}
              busy={busy}
              setBusy={setBusy}
              reopened={reopened}
              intend={intend}
              gateState={gateState}
              onChanged={onChanged}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── under-player strip: frames a–b · seconds · captions state · Fix-a-word ──

function UnderPlayerStrip({
  sid,
  scene,
  specScene,
  fps,
}: {
  sid: string;
  scene: SceneState;
  specScene: Spec['scenes'][number] | null;
  fps: number;
}) {
  const [fixOpen, setFixOpen] = useState(false);
  const a = specScene?.startFrame ?? 0;
  const dur = specScene?.durationInFrames ?? scene.durationInFrames ?? 0;
  const b = dur ? a + dur - 1 : a;
  // Hero templates render their own text → captions are suppressed by design.
  const isHero = scene.template === 'hook' || scene.template === 'outro' || scene.template === 'stat';

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 px-0.5">
      <span className="font-mono text-[11px] text-ink-muted tabular-nums">
        frames {a}–{b} · {(dur / fps).toFixed(1)}s
      </span>
      <Badge tone={isHero ? 'dim' : 'green'}>{isHero ? 'captions suppressed (hero)' : 'captions on'}</Badge>
      <button
        type="button"
        onClick={() => setFixOpen((v) => !v)}
        className="rounded-full bg-white/[0.06] px-2.5 py-1 font-ui text-[11px] font-semibold text-ink-secondary transition hover:bg-white/[0.1]"
      >
        Fix a word
      </button>
      {fixOpen && (
        <FixAWord sid={sid} startFrame={a} endFrame={b} onClose={() => setFixOpen(false)} />
      )}
    </div>
  );
}

// Scene-scoped transcript token editor — reuses studio.timing (the same op the
// hub's "Fix a word" uses), filtered to this scene's frame span.
function FixAWord({
  sid,
  startFrame,
  endFrame,
  onClose,
}: {
  sid: string;
  startFrame: number;
  endFrame: number;
  onClose: () => void;
}) {
  const [words, setWords] = useState<{index: number; text: string; startFrame: number; endFrame: number}[] | null>(null);
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    studio.timing
      .read(sid)
      .then((g) => {
        if (cancelled) return;
        setWords(g.words.filter((w) => w.endFrame >= startFrame && w.startFrame <= endFrame));
      })
      .catch(() => setWords([]));
    return () => {
      cancelled = true;
    };
  }, [sid, startFrame, endFrame]);

  async function submit(w: {index: number; text: string}) {
    const next = draft.trim();
    if (!next || next === w.text) {
      setEditIndex(null);
      return;
    }
    setSaving(true);
    try {
      const g = await studio.timing.fixWord(sid, w.index, next);
      setWords(g.words.filter((ww) => ww.endFrame >= startFrame && ww.startFrame <= endFrame));
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
    <div className="mt-2 w-full rounded-[var(--radius-md)] border border-white/10 bg-black/20 p-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="font-ui text-[11px] font-semibold text-ink-secondary">Transcript · this scene</span>
        <button onClick={onClose} aria-label="Close" className="text-ink-muted hover:text-ink">×</button>
      </div>
      {!words ? (
        <p className="font-mono text-[11px] text-ink-muted">loading…</p>
      ) : words.length === 0 ? (
        <p className="font-mono text-[11px] text-ink-muted">no words in this span</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
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
                    setEditIndex(null);
                  }
                }}
                onBlur={() => submit(w)}
                className="w-[7ch] rounded-[6px] border border-accent-1 bg-white/[0.06] px-2 py-1 font-mono text-[12px] text-ink outline-none"
              />
            ) : (
              <button
                key={w.index}
                onClick={() => {
                  setEditIndex(w.index);
                  setDraft(w.text);
                }}
                disabled={saving}
                className="rounded-[6px] bg-white/[0.05] px-2 py-1 font-mono text-[12px] text-ink-secondary transition hover:bg-white/[0.1] hover:text-ink disabled:opacity-50"
              >
                {w.text}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
