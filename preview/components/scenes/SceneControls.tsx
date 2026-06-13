'use client';

// Studio v3 M6 — T7 Scenes controls column.
//
//   • Template chips — eligible-only (scene.eligibleTemplates), AI pick tagged
//     `auto`, pick = pin via pick_template. 'scene' is disabled on a clip-less
//     hero (M5 amend 2: a hero→scene switch needs footage the hero lacks → 400).
//   • Footage pool (needsFootage) — rank badges, rank 1 = auto ("you're the
//     rerank"), pick swaps the clip. Empty-pool + Suggest/Re-query/Upload row.
//   • Background pool (hero) — tile 0 = the gradient floor (selected when there's
//     no background clip), then ranked clips + policy label; poolError → quota copy.
//   • Transition chips — none/fade/slide via the assemble patch path.
//   • Provenance popover — pickLogCount + last auto→human rank pair (ruling 19).

import {useRef, useState, type ReactNode} from 'react';
import {toast} from 'sonner';
import {studio, type SceneState, type Candidate, type GatesDict} from '@/lib/studio';
import type {Spec} from '@remotion-src/schema';
import {Badge, Eyebrow} from '@/components/ui';

type EditBody =
  | {op: 'pick'; scene: number; rank: number; target?: 'footage' | 'background'}
  | {op: 're_query'; scene: number; query?: string; broaden?: boolean; target?: 'footage' | 'background'}
  | {op: 'pick_template'; scene: number; template: string};

async function postEdit(sid: string, body: EditBody): Promise<void> {
  const res = await fetch(`/api/session/${sid}/edit`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(body),
  });
  if (res.status === 409) throw new Error('an edit is already in progress');
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.ok === false) throw new Error(json?.error ?? `HTTP ${res.status}`);
}

async function postUpload(sid: string, scene: number, file: File, target: 'footage' | 'background'): Promise<void> {
  const form = new FormData();
  form.append('op', 'upload');
  form.append('scene', String(scene));
  form.append('target', target);
  form.append('file', file);
  const res = await fetch(`/api/session/${sid}/edit`, {method: 'POST', body: form});
  if (res.status === 409) throw new Error('an edit is already in progress');
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.ok === false) throw new Error(json?.error ?? `HTTP ${res.status}`);
}

const TRANSITIONS: {value: 'none' | 'fade' | 'slide'; label: string}[] = [
  {value: 'none', label: 'Cut'},
  {value: 'fade', label: 'Fade'},
  {value: 'slide', label: 'Slide'},
];

export function SceneControls({
  sid,
  scene,
  total,
  fps,
  specScene,
  busy,
  setBusy,
  reopened,
  intend,
  gateState,
  onChanged,
}: {
  sid: string;
  scene: SceneState;
  total: number;
  fps: number;
  specScene: Spec['scenes'][number] | null;
  busy: boolean;
  setBusy: (b: boolean) => void;
  /** Scenes gate reopened — picks are deferred; show the pending affordance. */
  reopened: boolean;
  /** T9 §4.1 edit-intent guard — opens the sheet before the first edit at an approved gate. */
  intend: (apply: () => void | Promise<void>) => void;
  gateState: GatesDict['scenes'];
  onChanged: () => Promise<void>;
}) {
  const [reQueryText, setReQueryText] = useState('');
  const [suggesting, setSuggesting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const bgFileRef = useRef<HTMLInputElement>(null);

  const target: 'footage' | 'background' = scene.needsFootage ? 'footage' : 'background';
  const currentTemplate = scene.templateOverride?.value ?? scene.template;
  const overridden = scene.templateOverride != null;

  // The actual edit: single-flight + toast + state refresh.
  async function doRun(label: string, fn: () => Promise<void>) {
    if (busy) {
      toast.error('an edit is already in progress');
      return;
    }
    setBusy(true);
    const tId = toast.loading(label);
    try {
      await fn();
      await onChanged();
      toast.success(
        reopened ? 'Queued — applies on Re-approve' : 'Updated — preview refreshed',
        {id: tId, description: reopened ? undefined : 'Re-render to export the MP4.'},
      );
    } catch (e) {
      toast.error('Edit failed', {id: tId, description: e instanceof Error ? e.message : 'edit failed'});
    } finally {
      setBusy(false);
    }
  }

  // Gated edit-route ops (pick/template/re_query/upload) — the §4.1 sheet fires
  // before the first POST at an approved gate. Transitions use runNow (assemble
  // patch path; no gate reopen).
  function run(label: string, fn: () => Promise<void>) {
    intend(() => doRun(label, fn));
  }
  function runNow(label: string, fn: () => Promise<void>) {
    void doRun(label, fn);
  }

  async function suggest() {
    if (suggesting) return;
    setSuggesting(true);
    try {
      const r = await studio.footage.suggest(sid, scene.index);
      if (r?.query) setReQueryText(r.query);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'suggest failed');
    } finally {
      setSuggesting(false);
    }
  }

  // Transition patch via the assemble path (/scenes/{i}/transition).
  async function setTransition(value: 'none' | 'fade' | 'slide') {
    const dur = specScene?.transition?.durationInFrames ?? Math.max(6, Math.round(fps * 0.4));
    const patchValue = value === 'none' ? null : {template: value, durationInFrames: dur};
    runNow(`Setting ${value === 'none' ? 'hard cut' : value} transition…`, async () => {
      await studio.assemble.apply(sid, [{op: 'replace', path: `/scenes/${scene.index}/transition`, value: patchValue}]);
    });
  }

  const currentTransition = specScene?.transition?.template ?? 'none';
  const isLast = scene.index === total - 1;
  const heroClipless = !scene.needsFootage && scene.candidates.length === 0;

  return (
    <div className="min-w-0 space-y-4">
      {/* ── Template chips ─────────────────────────────────────────────────── */}
      {scene.eligibleTemplates.length > 0 && (
        <section>
          <Eyebrow className="mb-1.5">Template</Eyebrow>
          <div className="flex flex-wrap gap-1.5">
            {scene.eligibleTemplates.map((t) => {
              const active = t === currentTemplate;
              // 'scene' on a clip-less hero needs a footage pick first (M5 amend 2).
              const disabled = busy || (t === 'scene' && heroClipless && active === false);
              return (
                <button
                  key={t}
                  type="button"
                  disabled={disabled || active}
                  title={t === 'scene' && heroClipless ? 'pick a clip first — a scene template needs footage' : undefined}
                  onClick={() => run(`Switching to ${t}…`, () => postEdit(sid, {op: 'pick_template', scene: scene.index, template: t}))}
                  className={
                    'rounded-full px-3 py-1.5 font-ui text-[12px] font-semibold transition disabled:cursor-not-allowed ' +
                    (active
                      ? 'bg-accent-1 text-white'
                      : disabled
                        ? 'bg-white/[0.04] text-ink-muted opacity-50'
                        : 'bg-white/[0.06] text-ink-secondary hover:bg-white/[0.1]')
                  }
                >
                  {t}
                  {active && !overridden ? <span className="ml-1.5 font-mono text-[9px] opacity-80">auto</span> : null}
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* ── Footage pool (footage scenes) ──────────────────────────────────── */}
      {scene.needsFootage && (
        <section>
          <div className="mb-1.5 flex items-center justify-between">
            <Eyebrow>Footage</Eyebrow>
            <ProvenancePopover scene={scene} />
          </div>
          {scene.candidates.length === 0 ? (
            <EmptyPool query={scene.provenance?.query ?? null} />
          ) : (
            <>
              <p className="mb-2 font-ui text-[11px] text-ink-muted">rank 1 is the AI pick — you’re the rerank.</p>
              <ScrollPool>
                <PoolGrid
                  rows={scene.candidates}
                  disabled={busy}
                  pending={reopened}
                  onPick={(rank) => run('Swapping clip…', () => postEdit(sid, {op: 'pick', scene: scene.index, rank, target: 'footage'}))}
                />
              </ScrollPool>
            </>
          )}
          <SourceRow
            sid={sid}
            scene={scene.index}
            target="footage"
            reQueryText={reQueryText}
            setReQueryText={setReQueryText}
            suggesting={suggesting}
            onSuggest={suggest}
            busy={busy}
            fileRef={fileRef}
            run={run}
          />
        </section>
      )}

      {/* ── Background pool (hero scenes) ──────────────────────────────────── */}
      {!scene.needsFootage && (
        <section>
          <div className="mb-1.5 flex items-center justify-between">
            <Eyebrow>Background</Eyebrow>
            <ProvenancePopover scene={scene} />
          </div>
          <p className="mb-2 font-ui text-[11px] text-ink-muted">
            {scene.backgroundProvenance
              ? 'AI picked a filmable background — tile 0 is the gradient floor.'
              : 'AI kept the gradient — abstract beat. Pick a clip to add a background.'}
          </p>
          {scene.backgroundPool.poolError ? (
            <div className="rounded-[var(--radius-md)] bg-warn-soft px-3 py-2 font-ui text-[12px] text-warn">
              pool fetch hit the rate limit — {scene.backgroundPool.poolError}
            </div>
          ) : (
            <ScrollPool>
              <BackgroundGrid
                rows={scene.backgroundPool.rows}
                isGradient={scene.backgroundProvenance == null}
                disabled={busy}
                pending={reopened}
                onPick={(rank) => run('Swapping background…', () => postEdit(sid, {op: 'pick', scene: scene.index, rank, target: 'background'}))}
              />
            </ScrollPool>
          )}
          <SourceRow
            sid={sid}
            scene={scene.index}
            target="background"
            reQueryText={reQueryText}
            setReQueryText={setReQueryText}
            suggesting={suggesting}
            onSuggest={suggest}
            busy={busy}
            fileRef={bgFileRef}
            run={run}
          />
        </section>
      )}

      {/* ── Transition chips (not on the last scene — transition is OUT) ─────── */}
      {!isLast && (
        <section>
          <Eyebrow className="mb-1.5">Transition out</Eyebrow>
          <div className="flex flex-wrap gap-1.5">
            {TRANSITIONS.map((t) => {
              const active = currentTransition === t.value;
              return (
                <button
                  key={t.value}
                  type="button"
                  disabled={busy || active}
                  onClick={() => setTransition(t.value)}
                  className={
                    'rounded-full px-3 py-1.5 font-ui text-[12px] font-semibold transition disabled:cursor-not-allowed ' +
                    (active ? 'bg-accent-1 text-white' : 'bg-white/[0.06] text-ink-secondary hover:bg-white/[0.1] disabled:opacity-50')
                  }
                >
                  {t.label}
                </button>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

// ─── ScrollPool: clamp a pool grid to ~1.5 rows of vertical scroll ──────────
// Per-breakpoint max-h: 3-col tiles (mobile) are taller than 4-col tiles (sm:),
// so 1.5 rows is a different pixel height at each breakpoint. Derivation:
// tileW ≈ (colWidth); tileH = tileW * 16/9; clamp ≈ 1.5*tileH + 0.5*gap.
// Starting values below are validated/tuned in the browser eyes-on (item 7).
export function ScrollPool({children}: {children?: ReactNode}) {
  return (
    <div className="relative">
      <div
        data-scrollpool
        tabIndex={0}
        role="region"
        aria-label="Scrollable options"
        className="max-h-[260px] sm:max-h-[210px] overflow-y-auto scrollbar-hide"
      >
        {children}
      </div>
      {/* bottom fade — signals more content below the clamp */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-[var(--bg-surface)] to-transparent" />
    </div>
  );
}

// ─── footage pool grid ──────────────────────────────────────────────────────

function PoolGrid({
  rows,
  disabled,
  pending,
  onPick,
}: {
  rows: Candidate[];
  disabled: boolean;
  pending: boolean;
  onPick: (rank: number) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
      {rows.map((c) => {
        // At a reopened gate the selected pick is DEFERRED (ruling OV-12): amber
        // ring + "pending" — the player keeps the old clip until Re-approve.
        const pendingPick = pending && c.selected;
        return (
          <button
            key={c.rank}
            type="button"
            disabled={disabled || c.selected}
            onClick={() => onPick(c.rank)}
            aria-pressed={c.selected}
            aria-label={`Clip rank ${c.rank}${c.rank === 1 ? ' (AI pick)' : ''}${c.selected ? (pendingPick ? ' — pending, applies on Re-approve' : ' — selected') : ''}`}
            className={
              'group relative aspect-[9/16] overflow-hidden rounded-[var(--radius-sm)] border transition disabled:cursor-default ' +
              (c.selected
                ? pendingPick
                  ? 'border-warn ring-2 ring-warn'
                  : 'border-accent-1 ring-2 ring-accent-1'
                : 'border-white/10 hover:border-white/30')
            }
          >
            {c.thumbUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={c.thumbUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
            ) : (
              <div className="h-full w-full bg-white/[0.04]" />
            )}
            <span className="absolute left-1 top-1 rounded-full bg-black/60 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-white">
              {c.rank === 1 ? 'auto' : `#${c.rank}`}
            </span>
            {pendingPick && (
              <span className="absolute inset-x-0 bottom-0 bg-warn/90 px-1 py-0.5 text-center font-mono text-[8px] font-bold text-[#1a1308]">
                pending
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ─── background grid (tile 0 = gradient floor) ──────────────────────────────

function BackgroundGrid({
  rows,
  isGradient,
  disabled,
  pending,
  onPick,
}: {
  rows: Candidate[];
  isGradient: boolean;
  disabled: boolean;
  pending: boolean;
  onPick: (rank: number) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
      {/* Tile 0 — the gradient floor. Selected when there's no background clip.
          (Reverting to gradient has no backend op yet — it's the floor indicator.) */}
      <div
        aria-pressed={isGradient}
        aria-label="Gradient floor"
        title="Gradient floor — the default abstract background"
        className={
          'relative aspect-[9/16] overflow-hidden rounded-[var(--radius-sm)] border ' +
          (isGradient ? 'border-accent-1 ring-2 ring-accent-1' : 'border-white/10 opacity-70')
        }
      >
        <div className="h-full w-full bg-gradient-to-br from-[#5e5ce6] via-[#7c3aed] to-[#22d3ee]" />
        <span className="absolute left-1 top-1 rounded-full bg-black/60 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-white">
          gradient
        </span>
      </div>
      {rows.map((c) => {
        const pendingPick = pending && c.selected;
        return (
          <button
            key={c.rank}
            type="button"
            disabled={disabled || c.selected}
            onClick={() => onPick(c.rank)}
            aria-pressed={c.selected}
            className={
              'group relative aspect-[9/16] overflow-hidden rounded-[var(--radius-sm)] border transition disabled:cursor-default ' +
              (c.selected
                ? pendingPick
                  ? 'border-warn ring-2 ring-warn'
                  : 'border-accent-1 ring-2 ring-accent-1'
                : 'border-white/10 hover:border-white/30')
            }
          >
            {c.thumbUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={c.thumbUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
            ) : (
              <div className="h-full w-full bg-white/[0.04]" />
            )}
            <span className="absolute left-1 top-1 rounded-full bg-black/60 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-white">
              {c.rank === 1 ? 'auto' : `#${c.rank}`}
            </span>
            {pendingPick && (
              <span className="absolute inset-x-0 bottom-0 bg-warn/90 px-1 py-0.5 text-center font-mono text-[8px] font-bold text-[#1a1308]">
                pending
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ─── empty pool ─────────────────────────────────────────────────────────────

function EmptyPool({query}: {query: string | null}) {
  return (
    <div className="rounded-[var(--radius-md)] bg-white/[0.03] px-3 py-2.5 font-ui text-[12px] text-ink-muted">
      no clips found{query ? ` for “${query}”` : ''} — broaden to the topic title or upload your own.
    </div>
  );
}

// ─── suggest / re-query(broaden) / upload row ───────────────────────────────

function SourceRow({
  sid,
  scene,
  target,
  reQueryText,
  setReQueryText,
  suggesting,
  onSuggest,
  busy,
  fileRef,
  run,
}: {
  sid: string;
  scene: number;
  target: 'footage' | 'background';
  reQueryText: string;
  setReQueryText: (s: string) => void;
  suggesting: boolean;
  onSuggest: () => void;
  busy: boolean;
  fileRef: React.RefObject<HTMLInputElement | null>;
  run: (label: string, fn: () => Promise<void>) => void;
}) {
  return (
    <div className="mt-2.5 space-y-2">
      <div className="flex items-center gap-2">
        <input
          value={reQueryText}
          onChange={(e) => setReQueryText(e.target.value)}
          placeholder="re-query Pexels…"
          disabled={busy}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && reQueryText.trim()) {
              e.preventDefault();
              run('Re-querying footage…', () => postEdit(sid, {op: 're_query', scene, query: reQueryText.trim(), target}));
            }
          }}
          className="min-w-0 flex-1 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 font-ui text-[12px] text-ink outline-none placeholder:text-ink-muted focus:border-accent-1"
        />
        <button
          type="button"
          onClick={onSuggest}
          disabled={busy || suggesting}
          className="shrink-0 rounded-full bg-white/[0.06] px-3 py-1.5 font-ui text-[12px] font-semibold text-ink-secondary transition hover:bg-white/[0.1] disabled:opacity-50"
        >
          {suggesting ? 'Suggesting…' : 'Suggest'}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => run('Broadening to the topic…', () => postEdit(sid, {op: 're_query', scene, broaden: true, target}))}
          disabled={busy}
          className="rounded-full bg-white/[0.06] px-3 py-1.5 font-ui text-[12px] font-semibold text-ink-secondary transition hover:bg-white/[0.1] disabled:opacity-50"
        >
          Broaden to topic
        </button>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="rounded-full bg-white/[0.06] px-3 py-1.5 font-ui text-[12px] font-semibold text-ink-secondary transition hover:bg-white/[0.1] disabled:opacity-50"
        >
          Upload
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="video/*,image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) run('Uploading…', () => postUpload(sid, scene, f, target));
          }}
        />
      </div>
    </div>
  );
}

// ─── provenance popover (pickLogCount + last auto→human) ────────────────────

function ProvenancePopover({scene}: {scene: SceneState}) {
  const [open, setOpen] = useState(false);
  if (!scene.pickLogCount) return null;
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded-full bg-white/[0.06] px-2 py-0.5 font-mono text-[10px] font-semibold text-ink-muted transition hover:bg-white/[0.1] hover:text-ink"
        aria-expanded={open}
      >
        {scene.pickLogCount} pick{scene.pickLogCount === 1 ? '' : 's'}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-[200px] rounded-[var(--radius-md)] border border-white/10 bg-[#1a1a22] p-2.5 shadow-xl">
          <p className="font-ui text-[11px] text-ink-secondary">
            {scene.pickLogCount} pick{scene.pickLogCount === 1 ? '' : 's'} on this scene.
          </p>
          {scene.lastPick && (
            <p className="mt-1 font-mono text-[10px] text-ink-muted">
              last: auto #{scene.lastPick.autoRank} → you #{scene.lastPick.humanRank}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
