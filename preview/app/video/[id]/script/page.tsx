'use client';

import {useCallback, useEffect, useRef, useState} from 'react';
import {useParams, useRouter} from 'next/navigation';
import {toast} from 'sonner';
import {
  studio,
  frontierGate,
  type ScriptGate,
  type ScriptBeat,
  type StyleMemoryDoc,
  type GatesDict,
} from '@/lib/studio';
import {GateHeader, TintedButton} from '@/components/GateHeader';
import {GateInterstitial, type GateTask} from '@/components/GateInterstitial';
import {StatefulStamp} from '@/components/StatefulStamp';
import {useEditIntent} from '@/components/EditIntent';
import {useVideoLayout} from '@/components/VideoChrome';
import {Eyebrow, Badge} from '@/components/ui';
import {notifySpecChanged} from '@/components/PreviewRail';

function isReopenedGate(g: {state: string; approved_at: string | null} | undefined): boolean {
  if (!g) return false;
  return g.state === 'reopened' || (g.state === 'awaiting_approval' && g.approved_at != null);
}

// Studio v3 Script gate (PRD §6.1, M6-T3). The v2 beat-edit experience repositioned
// under the staged-flow chrome:
//   • building state — arrived from Topic on the sid event while the script stage
//     is still generating (ruling 2). VideoChrome polls /state; we flip to the
//     beats the moment gates.script appears.
//   • StatefulStamp — pre/post-approval gate line (§4.1.1) + the bandMiss warn pill.
//   • Approve is now the gate's one tinted action → studio.session.approve(id,'script')
//     SSE → GateInterstitial (replaces v2's synchronous approve). On done we navigate
//     to the live frontier (voice normally; assemble under auto-run).
// Style memory + inline edit + flag-only re-verify + drop + feedback regenerate are
// preserved from v2.

const QUICK_CHIPS = ['Punchier hook', 'Simpler words', 'Shorter beats', 'More numbers'] as const;

type Kind = 'Hook' | 'Outro' | 'Stat' | 'Scene';

function hasValueLabel(data: Record<string, unknown> | null): data is Record<string, unknown> {
  return !!data && data.value != null && data.label != null;
}

function beatKind(beat: ScriptBeat, index: number, total: number): Kind {
  if (hasValueLabel(beat.data)) return 'Stat';
  if (index === 0) return 'Hook';
  if (index === total - 1) return 'Outro';
  return 'Scene';
}

function dataChip(data: Record<string, unknown> | null): string | null {
  if (!hasValueLabel(data)) return null;
  const unit = data.unit != null ? ` ${String(data.unit)}` : '';
  return `${String(data.value)}${unit}`.trim();
}

function hostOf(source: string): string {
  try {
    return new URL(source).hostname.replace(/^www\./, '');
  } catch {
    return source;
  }
}

// How long we wait for the script gate to appear before surfacing a failed
// affordance — matches VideoChrome's POLL_CAP_MS.
const BUILD_TIMEOUT_MS = 120_000;

export default function ScriptGatePage() {
  const params = useParams();
  const id = params.id as string;
  const router = useRouter();

  const {gates, autoRun, refresh} = useVideoLayout();
  const scriptGate = gates.script;
  const gateReady = !!scriptGate; // gate row created = script stage finished
  const approved = scriptGate?.state === 'approved';
  const reopened = isReopenedGate(scriptGate);

  // T9 §4.1: at an APPROVED script gate, the first beat edit opens the
  // blast-radius sheet (POST withheld); Reopen fires it and reopens the gate.
  const {intend, sheet} = useEditIntent({sid: id, gate: 'script', gateState: scriptGate});

  const [gate, setGate] = useState<ScriptGate | null>(null);
  const [error, setError] = useState<string | null>(null);

  // edit state
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [savingIndex, setSavingIndex] = useState<number | null>(null);

  // feedback composer
  const [chips, setChips] = useState<Set<string>>(new Set());
  const [freetext, setFreetext] = useState('');
  const [regenerating, setRegenerating] = useState(false);

  // approve / re-approve = render the GateInterstitial in place of the page.
  //   'approve'   — first approval at the frontier → navigate forward on done.
  //   'reapprove' — §4.1 payment at a reopened gate → stay + refresh + frontier toast (ruling 4).
  const [approveMode, setApproveMode] = useState<null | 'approve' | 'reapprove'>(null);

  // building-elapsed tracking → failed affordance after the cap
  const [buildElapsed, setBuildElapsed] = useState(0);
  const buildStartRef = useRef<number | null>(null);

  // accepted edits this session, sent to approve as before/after pairs
  const editsRef = useRef<{before: string; after: string}[]>([]);

  const loadScript = useCallback(async () => {
    setError(null);
    try {
      const data = await studio.script.read(id);
      setGate(data);
    } catch (e) {
      // The gate row exists but the read raced (rare) — surface, the poll retries.
      setError(e instanceof Error ? e.message : 'failed to load script');
    }
  }, [id]);

  // Load the beats once the gate row appears.
  useEffect(() => {
    if (gateReady && !gate) void loadScript();
  }, [gateReady, gate, loadScript]);

  // Building elapsed ticker (only while not yet ready).
  useEffect(() => {
    if (gateReady) return;
    if (buildStartRef.current == null) buildStartRef.current = Date.now();
    const iv = setInterval(() => {
      setBuildElapsed(Math.floor((Date.now() - (buildStartRef.current ?? Date.now())) / 1000));
    }, 1000);
    return () => clearInterval(iv);
  }, [gateReady]);

  function startEdit(beat: ScriptBeat) {
    setEditingIndex(beat.index);
    setDraft(beat.text);
  }

  function cancelEdit() {
    setEditingIndex(null);
    setDraft('');
  }

  // Save is the edit intent (ruling OV-7: beat textarea = sheet on Save). At a
  // frontier gate intend() runs performSave immediately; at an approved gate it
  // opens the sheet first (the `next` value rides in the closure).
  function saveEdit(beat: ScriptBeat) {
    const next = draft.trim();
    if (!next || next === beat.text) {
      cancelEdit();
      return;
    }
    cancelEdit(); // exit edit mode now; Cancel on the sheet then reverts cleanly
    intend(() => performSave(beat, next));
  }

  async function performSave(beat: ScriptBeat, next: string) {
    setSavingIndex(beat.index);
    try {
      const updated = await studio.script.op(id, {op: 'edit_beat', index: beat.index, text: next});
      editsRef.current.push({before: beat.text, after: next});
      setGate(updated);
      notifySpecChanged();
      void refresh(); // an edit at an approved gate reopens it — sync the chrome
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'failed to save beat');
    } finally {
      setSavingIndex(null);
    }
  }

  function dropBeat(beat: ScriptBeat) {
    intend(() => performDrop(beat));
  }

  async function performDrop(beat: ScriptBeat) {
    setSavingIndex(beat.index);
    try {
      const updated = await studio.script.op(id, {op: 'drop_beat', index: beat.index});
      setGate(updated);
      if (editingIndex === beat.index) cancelEdit();
      notifySpecChanged();
      void refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'failed to drop beat');
    } finally {
      setSavingIndex(null);
    }
  }

  function toggleChip(chip: string) {
    setChips((prev) => {
      const next = new Set(prev);
      if (next.has(chip)) next.delete(chip);
      else next.add(chip);
      return next;
    });
  }

  function regenerate() {
    const feedback = [...QUICK_CHIPS.filter((c) => chips.has(c)), freetext.trim()]
      .filter(Boolean)
      .join('. ');
    intend(() => performRegenerate(feedback));
  }

  async function performRegenerate(feedback: string) {
    setRegenerating(true);
    try {
      const updated = await studio.script.op(id, {op: 'regenerate', feedback});
      setGate(updated);
      setChips(new Set());
      setFreetext('');
      notifySpecChanged();
      void refresh();
      toast.success('Script regenerated');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'failed to regenerate');
    } finally {
      setRegenerating(false);
    }
  }

  const factFloor = gate?.factFloor;
  const hardFail = factFloor?.level === 'hard_fail';
  const unverifiedCount = gate ? gate.beats.filter((b) => b.flag === 'unverified').length : 0;
  const bandMiss = gate?.bandMiss ?? null;

  const statusNode = gate ? (
    unverifiedCount > 0 ? (
      <Badge tone="amber" dot>
        {unverifiedCount} unverified
      </Badge>
    ) : (
      <Badge tone="green" dot>
        {factFloor?.supported ?? 0}/{factFloor?.total ?? 0} supported
      </Badge>
    )
  ) : null;

  // Fold accepted beat edits into style memory (the cross-video learning seam,
  // session_script.approve — a pure style_memory.json fold, no gate/spec mutation).
  // Fire-and-forget so it never blocks or fails the gate approve; the gatekeeper
  // SSE path doesn't carry edits, so this preserves v2's seeding behavior.
  function foldEditsIntoMemory() {
    const edits = editsRef.current;
    if (edits.length === 0) return;
    editsRef.current = [];
    void studio.script.op(id, {op: 'approve', edits, guidance: []}).catch(() => {});
  }

  function onApprove() {
    if (!gate || hardFail) return;
    foldEditsIntoMemory();
    setApproveMode('approve');
  }

  function onReapprove() {
    if (!gate || hardFail) return;
    foldEditsIntoMemory();
    setApproveMode('reapprove');
  }

  // The one tinted action by gate state (ruling 14 + §4.1):
  //   reopened → amber Re-approve · approved → done (no action) · frontier → Approve.
  const approveLabel = autoRun ? 'Approve & run all' : 'Approve';
  const action = !gate
    ? undefined
    : reopened ? (
        <TintedButton onClick={onReapprove} disabled={hardFail} variant="amber">
          Re-approve
        </TintedButton>
      ) : approved ? (
        <span className="rounded-full bg-white/[0.06] px-4 py-2 font-ui text-[13px] font-semibold text-ink-muted">
          Approved ✓
        </span>
      ) : (
        <TintedButton onClick={onApprove} disabled={hardFail}>
          {approveLabel}
        </TintedButton>
      );

  // ── approving: the GateInterstitial replaces the page body ──────────────────
  // Script approve runs the (empty) voice segment → near-instant; under auto-run
  // it cascades voice→timing→footage→assemble, so we name those tasks. Unknown
  // stages still render as synthetic cards (GateInterstitial handles them).
  const approveTasks: GateTask[] = autoRun
    ? [
        {key: 'voice', label: 'Voiceover'},
        {key: 'timing', label: 'Word timing'},
        {key: 'footage', label: 'Footage pools'},
        {key: 'assemble', label: 'Assembling first cut'},
      ]
    : [];

  if (approveMode) {
    const isReapprove = approveMode === 'reapprove';
    // Re-approve replays only the stale stages (rederive_stale emits real events).
    const reapproveTasks: GateTask[] = [
      {key: 'voice', label: 'Re-synthesizing narration'},
      {key: 'timing', label: 'Word timing'},
      {key: 'footage', label: 'Footage'},
      {key: 'assemble', label: 'Re-assembling'},
    ];
    return (
      <div>
        <GateHeader id={id} gate="script" gates={gates} />
        <GateInterstitial
          stream={() => studio.session.approve(id, 'script')}
          tasks={isReapprove ? reapproveTasks : approveTasks}
          sid={id}
          leaveCopy={
            isReapprove
              ? 'rebuilding the stale steps once — you can leave, it keeps running'
              : autoRun
                ? '~a few minutes — building the whole video; you can leave, it keeps running'
                : 'locking the script — the voice gate opens next'
          }
          onDone={(doneGates?: GatesDict) => {
            notifySpecChanged();
            if (isReapprove) {
              // Ruling 4: stay on the reopened gate; toast links the frontier.
              setApproveMode(null);
              void refresh();
              void loadScript();
              const next = doneGates && frontierGate(doneGates);
              if (next) {
                const label = next.charAt(0).toUpperCase() + next.slice(1);
                toast.success(`Rebuilt — ${label} is ready →`, {
                  action: {label: 'Go', onClick: () => router.push(`/video/${id}/${next}`)},
                  duration: 8000,
                });
              }
            } else {
              const next = (doneGates && frontierGate(doneGates)) ?? 'voice';
              router.push(`/video/${id}/${next}`);
            }
          }}
        />
      </div>
    );
  }

  return (
    <div>
      {sheet}
      <GateHeader id={id} gate="script" status={statusNode} action={gateReady ? action : undefined} gates={gates} />

      {/* Stateful stamp (§4.1.1) + credibility — only once the gate is real. */}
      {gateReady && gate && (
        <div className="content-card mb-4 px-4 py-3">
          <StatefulStamp
            gate="script"
            gateState={scriptGate}
            verifiedOk={factFloor?.supported}
            verifiedTotal={factFloor?.total}
          />
          {/* bandMiss warn pill (ruling 9) — verbatim copy. */}
          {bandMiss && (
            <div className="mt-2.5 flex items-start gap-2 rounded-[var(--radius-md)] bg-warn-soft px-3 py-2">
              <span className="mt-px text-warn" aria-hidden>⚠</span>
              <span className="font-ui text-[12.5px] font-medium text-warn">
                asked for {bandMiss.requested[0]}–{bandMiss.requested[1]} beats, got {bandMiss.got} —
                regenerate or approve as-is
              </span>
            </div>
          )}
        </div>
      )}

      {!gateReady ? (
        <BuildingCard elapsed={buildElapsed} timedOut={buildElapsed * 1000 > BUILD_TIMEOUT_MS} />
      ) : error && !gate ? (
        <div className="content-card p-5">
          <Eyebrow className="mb-1.5 text-warn">Couldn’t load the script</Eyebrow>
          <p className="font-ui text-[13px] text-ink-secondary">{error}</p>
          <button
            onClick={() => void loadScript()}
            className="mt-3 rounded-full bg-white/[0.07] px-4 py-2 font-ui text-[13px] font-semibold text-ink transition hover:bg-white/[0.12]"
          >
            Try again
          </button>
        </div>
      ) : !gate ? (
        <div className="space-y-2.5">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="content-card h-20 animate-pulse-dot" />
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          {hardFail ? (
            <div className="rounded-[var(--radius-lg)] border border-[rgba(245,158,11,0.3)] bg-[rgba(245,158,11,0.10)] px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="text-warn">⚠</span>
                <span className="font-ui text-[13px] font-semibold text-warn">
                  0 supported claims — add a source before approving
                </span>
              </div>
            </div>
          ) : null}

          {/* Beat list */}
          <div>
            <Eyebrow className="mb-2 px-1">{gate.title || 'Script'}</Eyebrow>
            {gate.beats.map((beat) => {
              const kind = beatKind(beat, beat.index, gate.beats.length);
              const chip = dataChip(beat.data);
              const isEditing = editingIndex === beat.index;
              const isSaving = savingIndex === beat.index;
              const host = beat.source ? hostOf(beat.source) : null;
              return (
                <div key={beat.index} className="content-card mb-2.5 p-4">
                  <div className="mb-2 flex items-center gap-2">
                    <Badge tone={kind === 'Stat' ? 'blue' : 'purple'}>{kind}</Badge>
                    {kind === 'Stat' && chip ? (
                      <Badge tone="blue">
                        <span className="font-mono">{chip}</span>
                      </Badge>
                    ) : null}
                    <span className="ml-auto">
                      <button
                        onClick={() => dropBeat(beat)}
                        disabled={isSaving}
                        aria-label="Drop beat"
                        title="Drop beat"
                        className="flex h-6 w-6 items-center justify-center rounded-full text-ink-muted transition hover:bg-white/[0.06] hover:text-warn disabled:opacity-40"
                      >
                        ×
                      </button>
                    </span>
                  </div>

                  {isEditing ? (
                    <div>
                      <textarea
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        autoFocus
                        rows={3}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            saveEdit(beat);
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            cancelEdit();
                          }
                        }}
                        className="w-full resize-none rounded-[var(--radius-md)] border border-white/10 bg-white/[0.04] px-3 py-2 font-ui text-[14px] text-ink outline-none focus:border-accent-1"
                      />
                      <div className="mt-2 flex items-center gap-2">
                        <button
                          onClick={() => saveEdit(beat)}
                          disabled={isSaving}
                          className="rounded-full bg-white/[0.07] px-3.5 py-1.5 font-ui text-[12px] font-semibold text-ink transition hover:bg-white/[0.12] disabled:opacity-50"
                        >
                          Save
                        </button>
                        <button
                          onClick={cancelEdit}
                          disabled={isSaving}
                          className="rounded-full px-3 py-1.5 font-ui text-[12px] font-semibold text-ink-muted transition hover:text-ink disabled:opacity-50"
                        >
                          Cancel
                        </button>
                        {isSaving ? (
                          <span className="font-ui text-[12px] text-ink-muted">re-verifying…</span>
                        ) : (
                          <span className="font-ui text-[11px] text-ink-muted">
                            Enter to save · Esc to cancel
                          </span>
                        )}
                      </div>
                    </div>
                  ) : (
                    <p
                      onClick={() => startEdit(beat)}
                      className="cursor-text rounded-[var(--radius-sm)] font-ui text-[14px] leading-relaxed text-ink transition hover:bg-white/[0.03]"
                      title="Click to edit"
                    >
                      {beat.text}
                    </p>
                  )}

                  {/* source + verify row */}
                  <div className="mt-2.5 flex flex-wrap items-center gap-2">
                    {host ? (
                      <span className="inline-flex items-center gap-1 font-mono text-[11px] text-ink-muted">
                        <span className="text-ok">✓</span>
                        {host}
                      </span>
                    ) : null}
                    {isSaving ? (
                      <span className="font-ui text-[12px] text-ink-muted">re-verifying…</span>
                    ) : beat.flag === 'supported' ? (
                      <Badge tone="green">✓ supported</Badge>
                    ) : beat.flag === 'unverified' ? (
                      <span className="inline-flex items-center gap-2">
                        <Badge tone="amber">unverified</Badge>
                        {beat.flagReason ? (
                          <span className="font-ui text-[12px] text-warn">{beat.flagReason}</span>
                        ) : null}
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Feedback composer */}
          <div className="content-card p-4">
            <Eyebrow className="mb-2.5">Regenerate with feedback</Eyebrow>
            <div className="mb-3 flex flex-wrap gap-2">
              {QUICK_CHIPS.map((c) => {
                const on = chips.has(c);
                return (
                  <button
                    key={c}
                    onClick={() => toggleChip(c)}
                    className={
                      'rounded-full px-3 py-1.5 font-ui text-[12px] font-semibold transition ' +
                      (on
                        ? 'bg-accent-1 text-white'
                        : 'bg-white/[0.06] text-ink-secondary hover:bg-white/[0.1]')
                    }
                  >
                    {c}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-2">
              <input
                value={freetext}
                onChange={(e) => setFreetext(e.target.value)}
                placeholder="Add a note for the rewrite…"
                disabled={regenerating}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    regenerate();
                  }
                }}
                className="min-w-0 flex-1 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 font-ui text-[13px] text-ink outline-none placeholder:text-ink-muted focus:border-accent-1"
              />
              <button
                onClick={regenerate}
                disabled={regenerating}
                className="flex shrink-0 items-center gap-2 rounded-full bg-white/[0.07] px-4 py-2 font-ui text-[13px] font-semibold text-ink transition hover:bg-white/[0.12] disabled:opacity-50"
              >
                {regenerating ? (
                  <>
                    <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    Regenerating…
                  </>
                ) : (
                  <>↻ Regenerate</>
                )}
              </button>
            </div>
          </div>

          {/* Style memory — F-6: the manager surface (list / pin / delete). */}
          <StyleMemoryCard id={id} />
        </div>
      )}
    </div>
  );
}

// Building card — shown while the script stage is still generating (arrived from
// Topic on the sid event). Mirrors the interstitial task-card vocabulary so the
// transition reads as one continuous flow.
function BuildingCard({elapsed, timedOut}: {elapsed: number; timedOut: boolean}) {
  if (timedOut) {
    return (
      <div className="content-card p-5" role="alert">
        <Eyebrow className="mb-1.5 text-warn">Still building — or the draft failed</Eyebrow>
        <p className="font-ui text-[13px] leading-relaxed text-ink-secondary">
          The script hasn’t arrived after {Math.floor(elapsed)} s. It may still be running, or the
          draft failed. You can keep waiting, or return home and start again.
        </p>
        <a
          href="/"
          className="mt-3 inline-block rounded-full bg-white/[0.07] px-4 py-2 font-ui text-[13px] font-semibold text-ink transition hover:bg-white/[0.12]"
        >
          ← Back to home
        </a>
      </div>
    );
  }
  return (
    <div className="content-card mx-auto mt-4 max-w-[480px] px-[22px] pb-[18px] pt-[22px]" aria-live="polite">
      <div className="flex items-center gap-[11px] px-0.5 py-[9px] font-ui text-[13.5px] font-[550] text-ink">
        <span className="relative flex h-[20px] w-[20px] flex-none items-center justify-center rounded-full bg-warn-soft text-warn">
          <span
            className="absolute h-[9px] w-[9px] rounded-full border-2 border-warn border-t-transparent animate-spin"
            style={{animationDuration: '0.7s', animationTimingFunction: 'linear'}}
          />
        </span>
        <span className="flex-1">Generating script</span>
        <span className="ml-auto font-mono text-[10.5px] tabular-nums text-ink-muted" aria-hidden>
          {elapsed} s
        </span>
      </div>
      <p className="mt-[14px] text-center font-mono text-[11px] text-ink-muted">
        grounding facts and verifying sources — you can leave, it keeps building
      </p>
    </div>
  );
}

function StyleMemoryCard({id}: {id: string}) {
  const [mem, setMem] = useState<StyleMemoryDoc | null>(null);
  const [busy, setBusy] = useState(false);

  const loadMem = useCallback(async () => {
    try {
      const res = await studio.script.styleMemory(id, {op: 'style_memory_read'});
      setMem(res.styleMemory);
    } catch {
      // Non-fatal: keep whatever state we have (initial null degrades to the
      // footnote). Nulling here would let a 409 from the single-flight guard —
      // e.g. dev StrictMode double-mount racing two reads — blank a loaded card.
    }
  }, [id]);

  useEffect(() => {
    loadMem();
  }, [loadMem]);

  async function run(body: Parameters<typeof studio.script.styleMemory>[1]) {
    setBusy(true);
    try {
      const res = await studio.script.styleMemory(id, body);
      setMem(res.styleMemory);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'style memory op failed');
    } finally {
      setBusy(false);
    }
  }

  const PinButton = ({kind, index, pinned}: {kind: 'example' | 'guidance'; index: number; pinned: boolean}) => (
    <button
      onClick={() => run({op: 'style_memory_pin', kind, index, value: !pinned})}
      disabled={busy}
      title={pinned ? 'Unpin (FIFO can evict again)' : 'Pin (never FIFO-evicted)'}
      className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold transition disabled:opacity-40 ${
        pinned ? 'bg-accent-1/20 text-accent-1' : 'bg-white/[0.06] text-ink-muted hover:text-ink'
      }`}
    >
      {pinned ? 'pinned' : 'pin'}
    </button>
  );

  const DeleteButton = ({kind, index}: {kind: 'example' | 'guidance'; index: number}) => (
    <button
      onClick={() => run({op: 'style_memory_delete', kind, index})}
      disabled={busy}
      title="Delete this entry"
      className="rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold text-ink-muted transition hover:bg-white/[0.06] hover:text-warn disabled:opacity-40"
    >
      ×
    </button>
  );

  return (
    <div className="content-card p-4">
      <div className="mb-1.5 flex items-center justify-between">
        <Eyebrow>Style memory</Eyebrow>
        {mem ? (
          <span className="font-mono text-[10px] text-ink-muted">
            {mem.guidance.length}/{mem.caps.guidance} guidance · {mem.examples.length}/{mem.caps.examples} examples
          </span>
        ) : null}
      </div>
      <p className="font-ui text-[12px] leading-relaxed text-ink-muted">
        Saved as few-shot examples and prompt guidance that seed future scripts. DeepSeek is
        hosted and stateless — it doesn't learn from chats; this memory is how it gets better
        next time.
      </p>

      {mem && (mem.guidance.length > 0 || mem.examples.length > 0) ? (
        <div className="mt-3 space-y-2">
          {mem.guidance.map((g) => (
            <div key={`g${g.index}`} className="flex items-center gap-2 rounded-[var(--radius-md)] bg-white/[0.03] px-2.5 py-1.5">
              <span className="min-w-0 flex-1 truncate font-ui text-[12px] text-ink-secondary" title={g.text}>
                {g.text}
              </span>
              <PinButton kind="guidance" index={g.index} pinned={g.pinned} />
              <DeleteButton kind="guidance" index={g.index} />
            </div>
          ))}
          {mem.examples.map((e) => (
            <div key={`e${e.index}`} className="flex items-center gap-2 rounded-[var(--radius-md)] bg-white/[0.03] px-2.5 py-1.5">
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-secondary" title={`${e.before} → ${e.after}`}>
                <span className="text-ink-muted line-through">{e.before}</span>
                <span className="text-ink-muted"> → </span>
                {e.after}
              </span>
              <PinButton kind="example" index={e.index} pinned={e.pinned} />
              <DeleteButton kind="example" index={e.index} />
            </div>
          ))}
        </div>
      ) : mem ? (
        <p className="mt-2 font-ui text-[11px] text-ink-muted">Empty — entries appear after your first Approve.</p>
      ) : null}
    </div>
  );
}
