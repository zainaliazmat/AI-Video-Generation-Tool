'use client';

import {useState} from 'react';
import {toast} from 'sonner';
import {Button, Eyebrow} from './ui';

/**
 * Topic entry (spec §10.8 Home). The script→...→assemble backend lands in
 * Phase 4; until then "Generate" explains that and the renderer runs on the
 * existing sample spec.
 */
export function TopicInput() {
  const [topic, setTopic] = useState('');

  const onGenerate = () => {
    toast.info('Backend pipeline arrives in Phase 4', {
      description:
        'For now, scrub the sample on the right and click "Render MP4" to export it.',
    });
  };

  return (
    <div className="glass glass-hover rounded-xl p-5">
      <Eyebrow>New video</Eyebrow>
      <div className="mt-3 flex flex-col gap-3 sm:flex-row">
        <input
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onGenerate()}
          placeholder="3 facts about deep sea creatures…"
          className="flex-1 rounded-[var(--radius-md)] border border-glass bg-white/[0.02] px-4 py-3 font-ui text-[14px] text-ink outline-none transition-all duration-150 ease-out placeholder:text-ink-muted focus:border-[var(--glass-border-active)] focus:bg-white/[0.04] focus:shadow-[0_0_0_4px_rgba(99,102,241,0.12)]"
        />
        <Button onClick={onGenerate} className="shrink-0">
          Generate
        </Button>
      </div>
      <p className="mt-2 font-ui text-[12px] text-ink-muted">
        Generation (script → voice → timing → footage) wires up in Phase 4.
      </p>
    </div>
  );
}
