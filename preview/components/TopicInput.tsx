'use client';

import {useState} from 'react';
import {Button, Eyebrow} from './ui';

/**
 * Topic entry (spec §10.8 Home). "Generate" runs the backend pipeline via
 * /api/generate; the parent (Studio) owns the request + live stepper state.
 */
export function TopicInput({
  onGenerate,
  busy,
}: {
  onGenerate: (topic: string) => void;
  busy: boolean;
}) {
  const [topic, setTopic] = useState('');

  const submit = () => {
    const t = topic.trim();
    if (!t || busy) return;
    onGenerate(t);
  };

  return (
    <div className="glass glass-hover rounded-xl p-5">
      <Eyebrow>New video</Eyebrow>
      <div className="mt-3 flex flex-col gap-3 sm:flex-row">
        <input
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          disabled={busy}
          placeholder="3 facts about deep sea creatures…"
          className="flex-1 rounded-[var(--radius-md)] border border-glass bg-white/[0.02] px-4 py-3 font-ui text-[14px] text-ink outline-none transition-all duration-150 ease-out placeholder:text-ink-muted focus:border-[var(--glass-border-active)] focus:bg-white/[0.04] focus:shadow-[0_0_0_4px_rgba(99,102,241,0.12)] disabled:opacity-50"
        />
        <Button onClick={submit} disabled={busy} className="shrink-0">
          {busy ? 'Generating…' : 'Generate'}
        </Button>
      </div>
      <p className="mt-2 font-ui text-[12px] text-ink-muted">
        Runs the full pipeline locally: script → voice → timing → footage → assemble.
      </p>
    </div>
  );
}
