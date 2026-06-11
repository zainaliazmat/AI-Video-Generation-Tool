'use client';

import {useCallback, useEffect, useRef, useState} from 'react';
import {useParams} from 'next/navigation';
import {toast} from 'sonner';
import {studio, type ScriptGate, type ScriptBeat, type StyleMemoryDoc} from '@/lib/studio';
import {GateHeader, TintedButton} from '@/components/GateHeader';
import {Eyebrow, Badge} from '@/components/ui';
import {notifySpecChanged} from '@/components/PreviewRail';

// Studio v2 Script gate (PRD §6.1 + §9 Liquid Glass). Content sits on quiet
// `content-card` surfaces; the GateHeader is the floating glass toolbar carrying
// the single tinted action (Approve). Semantic colors are fixed: green=verified,
// amber/warn=unverified, blue=stat/data, indigo(accent-1)=action.

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

export default function ScriptGatePage() {
  const params = useParams();
  const id = params.id as string;

  const [gate, setGate] = useState<ScriptGate | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // edit state
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [savingIndex, setSavingIndex] = useState<number | null>(null);

  // feedback composer
  const [chips, setChips] = useState<Set<string>>(new Set());
  const [freetext, setFreetext] = useState('');
  const [regenerating, setRegenerating] = useState(false);

  const [approving, setApproving] = useState(false);

  // accepted edits this session, sent to approve as before/after pairs
  const editsRef = useRef<{before: string; after: string}[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await studio.script.read(id);
      setGate(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load script');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  function startEdit(beat: ScriptBeat) {
    setEditingIndex(beat.index);
    setDraft(beat.text);
  }

  function cancelEdit() {
    setEditingIndex(null);
    setDraft('');
  }

  async function saveEdit(beat: ScriptBeat) {
    const next = draft.trim();
    if (!next || next === beat.text) {
      cancelEdit();
      return;
    }
    setSavingIndex(beat.index);
    try {
      const updated = await studio.script.op(id, {op: 'edit_beat', index: beat.index, text: next});
      editsRef.current.push({before: beat.text, after: next});
      setGate(updated);
      cancelEdit();
      notifySpecChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'failed to save beat');
    } finally {
      setSavingIndex(null);
    }
  }

  async function dropBeat(beat: ScriptBeat) {
    if (!window.confirm('Drop this beat? This removes it from the script.')) return;
    setSavingIndex(beat.index);
    try {
      const updated = await studio.script.op(id, {op: 'drop_beat', index: beat.index});
      setGate(updated);
      if (editingIndex === beat.index) cancelEdit();
      notifySpecChanged();
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

  async function regenerate() {
    const feedback = [...QUICK_CHIPS.filter((c) => chips.has(c)), freetext.trim()]
      .filter(Boolean)
      .join('. ');
    setRegenerating(true);
    try {
      const updated = await studio.script.op(id, {op: 'regenerate', feedback});
      setGate(updated);
      setChips(new Set());
      setFreetext('');
      notifySpecChanged();
      toast.success('Script regenerated');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'failed to regenerate');
    } finally {
      setRegenerating(false);
    }
  }

  async function approve() {
    if (hardFail) return;
    setApproving(true);
    try {
      await studio.script.op(id, {op: 'approve', edits: editsRef.current, guidance: []});
      toast.success('Script approved');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'failed to approve');
    } finally {
      setApproving(false);
    }
  }

  const factFloor = gate?.factFloor;
  const hardFail = factFloor?.level === 'hard_fail';
  const unverifiedCount = gate ? gate.beats.filter((b) => b.flag === 'unverified').length : 0;

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

  const action = (
    <TintedButton onClick={approve} disabled={!gate || hardFail || approving}>
      {approving ? 'Approving…' : 'Approve'}
    </TintedButton>
  );

  return (
    <div>
      <GateHeader id={id} gate="script" status={statusNode} action={action} />

      {loading ? (
        <div className="space-y-2.5">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="content-card h-20 animate-pulse-dot" />
          ))}
        </div>
      ) : error ? (
        <div className="content-card p-5">
          <Eyebrow className="mb-1.5 text-warn">Couldn’t load the script</Eyebrow>
          <p className="font-ui text-[13px] text-ink-secondary">{error}</p>
          <button
            onClick={load}
            className="mt-3 rounded-full bg-white/[0.07] px-4 py-2 font-ui text-[13px] font-semibold text-ink transition hover:bg-white/[0.12]"
          >
            Try again
          </button>
        </div>
      ) : gate ? (
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
            {gate.title ? (
              <Eyebrow className="mb-2 px-1">{gate.title}</Eyebrow>
            ) : (
              <Eyebrow className="mb-2 px-1">Script</Eyebrow>
            )}
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

          {/* Style memory — F-6: the manager surface (list / pin / delete). Memory
              grows on Approve; pinned entries are never FIFO-evicted. */}
          <StyleMemoryCard id={id} />
        </div>
      ) : null}
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
      setMem(null); // non-fatal: the card degrades to the footnote only
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
