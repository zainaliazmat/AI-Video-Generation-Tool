'use client';

import {useCallback, useEffect, useRef, useState} from 'react';
import {useParams} from 'next/navigation';
import {toast} from 'sonner';
import {studio, type AssembleGate, type ChatResult, type DiffLine} from '@/lib/studio';
import {GateHeader} from '@/components/GateHeader';
import {Eyebrow, Badge} from '@/components/ui';
import {RenderControls} from '@/components/RenderControls';
import {notifySpecChanged} from '@/components/PreviewRail';

// Studio v2 Assemble gate (PRD §6.5). The director chat → spec.json patch card →
// apply & re-render. Frames are never edited; spec.json is the contract. Content
// sits on quiet `content-card` surfaces; the single tinted action ("Apply &
// re-render") lives on the patch card, not the GateHeader.

const QUICK_CHIPS = [
  'Make the captions bigger',
  'Switch to a dark ember theme',
  "Swap scene 1's clip",
  'Snappier transitions',
] as const;

type ChatMessage =
  | {kind: 'user'; id: string; text: string}
  | {kind: 'assistant'; id: string; text: string}
  | {kind: 'patch'; id: string; result: ChatResult; status: 'pending' | 'applied'};

function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

let counter = 0;
const nextId = () => `m${++counter}-${Date.now()}`;

function DiffRow({line}: {line: DiffLine}) {
  return (
    <div className="font-mono text-[11px] leading-relaxed">
      <span className="text-ink-muted">{line.path}: </span>
      <span className="text-[#f87171] line-through">{fmtValue(line.before)}</span>
      <span className="text-ink-muted"> → </span>
      <span className="text-[#34d399]">{fmtValue(line.after)}</span>
    </div>
  );
}

export default function AssembleGatePage() {
  const params = useParams();
  const id = params.id as string;

  const [gate, setGate] = useState<AssembleGate | null>(null);
  const [spec, setSpec] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [applyingId, setApplyingId] = useState<string | null>(null);

  const threadRef = useRef<HTMLDivElement | null>(null);

  const loadGate = useCallback(async () => {
    const data = await studio.assemble.read(id);
    setGate(data);
  }, [id]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [g, project] = await Promise.all([studio.assemble.read(id), studio.project(id)]);
      setGate(g);
      setSpec(project.spec);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load assemble gate');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // Keep the thread scrolled to the newest message.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || sending) return;
    setInput('');
    setMessages((prev) => [...prev, {kind: 'user', id: nextId(), text: message}]);
    setSending(true);
    try {
      const result = await studio.assemble.chat(id, message);
      if (result.valid === false || result.ops.length === 0) {
        // Honest-failure path: no patch, just the director explaining what can/can't move.
        setMessages((prev) => [
          ...prev,
          {kind: 'assistant', id: nextId(), text: result.reply || 'Nothing to change there.'},
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          {kind: 'patch', id: nextId(), result, status: 'pending'},
        ]);
      }
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        {
          kind: 'assistant',
          id: nextId(),
          text: e instanceof Error ? e.message : 'The director couldn’t respond.',
        },
      ]);
    } finally {
      setSending(false);
    }
  }

  async function applyPatch(msg: Extract<ChatMessage, {kind: 'patch'}>) {
    setApplyingId(msg.id);
    try {
      await studio.assemble.apply(id, msg.result.ops);
      setMessages((prev) =>
        prev.map((m) => (m.id === msg.id && m.kind === 'patch' ? {...m, status: 'applied'} : m)),
      );
      toast.success('Patch applied · re-rendering');
      notifySpecChanged();
      await loadGate();
      // Refresh the spec for RenderControls too.
      try {
        const project = await studio.project(id);
        setSpec(project.spec);
      } catch {
        /* non-fatal: the gate summary already refreshed */
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'failed to apply patch');
    } finally {
      setApplyingId(null);
    }
  }

  function discardPatch(msgId: string) {
    setMessages((prev) => prev.filter((m) => m.id !== msgId));
  }

  const palette: string[] = Array.isArray((gate?.theme as any)?.palette)
    ? ((gate!.theme as any).palette as unknown[]).map((c) => String(c))
    : [];
  const themeName =
    typeof (gate?.theme as any)?.name === 'string' ? String((gate!.theme as any).name) : null;

  const statusNode = gate ? (
    <Badge tone="purple" dot>
      {gate.scenes.length} scenes
    </Badge>
  ) : null;

  return (
    <div>
      <GateHeader id={id} gate="assemble" status={statusNode} />

      {loading ? (
        <div className="space-y-2.5">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="content-card h-24 animate-pulse-dot" />
          ))}
        </div>
      ) : error ? (
        <div className="content-card p-5">
          <Eyebrow className="mb-1.5 text-warn">Couldn’t load the assemble gate</Eyebrow>
          <p className="font-ui text-[13px] text-ink-secondary">{error}</p>
          <button
            onClick={load}
            className="mt-3 rounded-full bg-white/[0.07] px-4 py-2 font-ui text-[13px] font-semibold text-ink transition hover:bg-white/[0.12]"
          >
            Try again
          </button>
        </div>
      ) : gate ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
          {/* Director chat column */}
          <div className="min-w-0 space-y-4">
            <div className="content-card flex flex-col p-4">
              <Eyebrow className="mb-3">Director</Eyebrow>

              <div
                ref={threadRef}
                className="flex max-h-[420px] min-h-[160px] flex-col gap-3 overflow-y-auto pr-1"
              >
                {messages.length === 0 ? (
                  <p className="font-ui text-[13px] leading-relaxed text-ink-muted">
                    Tell the director what to change — themes, captions, clips, transitions. Every
                    edit becomes a typed spec.json patch you review before it re-renders. Frames are
                    never touched directly.
                  </p>
                ) : null}

                {messages.map((m) => {
                  if (m.kind === 'user') {
                    return (
                      <div key={m.id} className="flex justify-end">
                        <div className="max-w-[85%] rounded-[var(--radius-lg)] rounded-br-sm bg-accent-1 px-3.5 py-2 font-ui text-[13px] leading-relaxed text-white">
                          {m.text}
                        </div>
                      </div>
                    );
                  }
                  if (m.kind === 'assistant') {
                    return (
                      <div key={m.id} className="flex justify-start">
                        <div className="max-w-[85%] rounded-[var(--radius-lg)] rounded-bl-sm bg-white/[0.05] px-3.5 py-2 font-ui text-[13px] leading-relaxed text-ink-secondary">
                          {m.text}
                        </div>
                      </div>
                    );
                  }
                  // patch card
                  const applied = m.status === 'applied';
                  const isApplying = applyingId === m.id;
                  return (
                    <div key={m.id} className="flex justify-start">
                      <div className="w-full max-w-[95%]">
                        {m.result.reply ? (
                          <div className="mb-2 max-w-[85%] rounded-[var(--radius-lg)] rounded-bl-sm bg-white/[0.05] px-3.5 py-2 font-ui text-[13px] leading-relaxed text-ink-secondary">
                            {m.result.reply}
                          </div>
                        ) : null}
                        <div className="rounded-[var(--radius-lg)] border border-[rgba(16,185,129,0.35)] bg-[rgba(16,185,129,0.05)] p-3.5">
                          <div className="mb-2.5 flex items-center gap-2">
                            <Eyebrow className="text-[#34d399]">spec.json patch</Eyebrow>
                            {applied ? (
                              <Badge tone="green" dot>
                                applied
                              </Badge>
                            ) : null}
                          </div>

                          <div className="space-y-1 rounded-[var(--radius-md)] bg-black/20 p-2.5">
                            {m.result.diff.length ? (
                              m.result.diff.map((line, i) => <DiffRow key={i} line={line} />)
                            ) : (
                              <div className="font-mono text-[11px] text-ink-muted">
                                {m.result.ops.length} op
                                {m.result.ops.length === 1 ? '' : 's'}
                              </div>
                            )}
                          </div>

                          <div className="mt-2.5 flex flex-wrap gap-1.5">
                            <Badge tone="green">valid · zod + pydantic</Badge>
                            <Badge tone="green">audio math untouched</Badge>
                          </div>

                          {!applied ? (
                            <div className="mt-3 flex items-center gap-2">
                              <button
                                onClick={() => applyPatch(m)}
                                disabled={isApplying}
                                className="rounded-full bg-accent-1 px-5 py-2 font-ui text-[13px] font-semibold text-white shadow-[0_6px_18px_rgba(94,92,230,0.4)] transition hover:brightness-110 disabled:opacity-50"
                              >
                                {isApplying ? 'Applying…' : 'Apply & re-render'}
                              </button>
                              <button
                                onClick={() => discardPatch(m.id)}
                                disabled={isApplying}
                                className="rounded-full px-4 py-2 font-ui text-[13px] font-semibold text-ink-muted transition hover:bg-white/[0.06] hover:text-ink disabled:opacity-50"
                              >
                                Discard
                              </button>
                            </div>
                          ) : (
                            <p className="mt-3 font-ui text-[12px] text-ink-muted">
                              Patched into spec.json — re-render below to see it.
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}

                {sending ? (
                  <div className="flex justify-start">
                    <div className="inline-flex items-center gap-2 rounded-[var(--radius-lg)] rounded-bl-sm bg-white/[0.05] px-3.5 py-2 font-ui text-[13px] text-ink-muted">
                      <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                      thinking…
                    </div>
                  </div>
                ) : null}
              </div>

              {/* Quick chips */}
              <div className="mt-3 flex flex-wrap gap-2">
                {QUICK_CHIPS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setInput(c)}
                    disabled={sending}
                    className="rounded-full bg-white/[0.06] px-3 py-1.5 font-ui text-[12px] font-semibold text-ink-secondary transition hover:bg-white/[0.1] disabled:opacity-50"
                  >
                    {c}
                  </button>
                ))}
              </div>

              {/* Composer */}
              <div className="mt-3 flex items-center gap-2">
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Tell the director what to change…"
                  disabled={sending}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      send(input);
                    }
                  }}
                  className="min-w-0 flex-1 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 font-ui text-[13px] text-ink outline-none placeholder:text-ink-muted focus:border-accent-1"
                />
                <button
                  onClick={() => send(input)}
                  disabled={sending || !input.trim()}
                  className="shrink-0 rounded-full bg-white/[0.07] px-4 py-2 font-ui text-[13px] font-semibold text-ink transition hover:bg-white/[0.12] disabled:opacity-50"
                >
                  Send
                </button>
              </div>
            </div>

            {/* Render section */}
            {spec ? (
              <div className="space-y-1.5">
                <RenderControls spec={spec} projectId={id} onRendered={() => {}} />
                <p className="px-1 font-ui text-[11px] text-ink-muted">~40 s local re-render</p>
              </div>
            ) : (
              <div className="content-card p-4">
                <p className="font-ui text-[12px] text-ink-muted">
                  Spec unavailable — render disabled.
                </p>
              </div>
            )}
          </div>

          {/* Scene / theme summary column */}
          <div className="space-y-4">
            <div className="content-card p-4">
              <Eyebrow className="mb-2.5">Theme{themeName ? ` · ${themeName}` : ''}</Eyebrow>
              {palette.length ? (
                <div className="flex flex-wrap gap-2">
                  {palette.map((c, i) => (
                    <div key={i} className="flex flex-col items-center gap-1">
                      <span
                        className="h-8 w-8 rounded-[var(--radius-sm)] border border-white/10"
                        style={{backgroundColor: c}}
                        title={c}
                      />
                      <span className="font-mono text-[9px] text-ink-muted">{c}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="font-ui text-[12px] text-ink-muted">No palette in theme.</p>
              )}
            </div>

            <div className="content-card p-4">
              <Eyebrow className="mb-2.5">Scenes</Eyebrow>
              <div className="space-y-2">
                {gate.scenes.map((s) => (
                  <div
                    key={s.index}
                    className="flex items-center gap-2 rounded-[var(--radius-md)] bg-white/[0.03] px-2.5 py-2"
                  >
                    <span className="font-mono text-[11px] text-ink-muted">
                      {String(s.index + 1).padStart(2, '0')}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-ui text-[12px] text-ink-secondary">
                      {s.template ?? 'untemplated'}
                    </span>
                    {s.hasMedia ? (
                      <Badge tone="blue">clip</Badge>
                    ) : (
                      <Badge tone="dim">no clip</Badge>
                    )}
                    {s.transition ? (
                      <span className="font-mono text-[10px] text-ink-muted">{s.transition}</span>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
