'use client';

import {useEffect} from 'react';
import {AnimatePresence, motion} from 'framer-motion';
import {Badge, Eyebrow} from './ui';
import {kindTone, frameRange, propRows} from '@/lib/template-ui';
import type {TemplateMeta} from '@/lib/templates';

/** Detail drawer: full contract for one template (preview + sampleProps + the
 * inputSchema props table). Closes on backdrop click or Escape. */
export function TemplateDrawer({template, onClose}: {template: TemplateMeta | null; onClose: () => void}) {
  useEffect(() => {
    if (!template) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [template, onClose]);

  return (
    <AnimatePresence>
      {template && (
        <>
          <motion.div
            className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm"
            initial={{opacity: 0}}
            animate={{opacity: 1}}
            exit={{opacity: 0}}
            onClick={onClose}
          />
          <motion.aside
            className="fixed right-0 top-0 z-40 flex h-full w-full max-w-[440px] flex-col gap-5 overflow-y-auto border-l border-glass bg-[#0b0b10] p-6"
            initial={{x: '100%'}}
            animate={{x: 0}}
            exit={{x: '100%'}}
            transition={{type: 'spring', stiffness: 320, damping: 34}}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-ui text-[20px] font-semibold tracking-[-0.01em] text-ink">{template.name}</h2>
                <div className="mt-1.5 flex items-center gap-2">
                  <Badge tone={kindTone(template.kind)}>{template.kind}</Badge>
                  <span className="font-mono text-[11px] tabular-nums text-ink-muted">
                    {frameRange(template.durationFrames)} · v{template.version} · {template.author}
                  </span>
                </div>
              </div>
              <button
                onClick={onClose}
                className="rounded-[7px] px-2 py-1 font-ui text-[13px] text-ink-muted transition-colors hover:bg-white/[0.06] hover:text-ink"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <div className="overflow-hidden rounded-[var(--radius-md)] bg-black">
              {template.mp4 ? (
                <video
                  src={template.mp4}
                  poster={template.poster ?? undefined}
                  autoPlay
                  loop
                  muted
                  playsInline
                  className="aspect-[9/16] w-full object-cover"
                />
              ) : (
                <div className="flex aspect-[9/16] items-center justify-center font-ui text-[12px] text-ink-muted">
                  preview pending
                </div>
              )}
            </div>

            <Section title="Props (inputSchema)">
              <PropsTable template={template} />
            </Section>

            <Section title="Sample props">
              <pre className="overflow-x-auto rounded-[8px] border border-glass bg-white/[0.02] p-3 font-mono text-[11.5px] leading-relaxed text-ink-secondary">
                {JSON.stringify(template.sampleProps, null, 2)}
              </pre>
            </Section>

            <p className="font-mono text-[10.5px] text-ink-muted">apiVersion {template.apiVersion}</p>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

function Section({title, children}: {title: string; children: React.ReactNode}) {
  return (
    <section>
      <Eyebrow className="mb-2">{title}</Eyebrow>
      {children}
    </section>
  );
}

function PropsTable({template}: {template: TemplateMeta}) {
  const rows = propRows(template.inputSchema);
  if (rows.length === 0) {
    return <p className="font-ui text-[12px] text-ink-muted">No input props.</p>;
  }
  return (
    <div className="overflow-hidden rounded-[8px] border border-glass">
      {rows.map((r, i) => (
        <div
          key={r.name}
          className={`flex items-center justify-between gap-3 px-3 py-2 ${i % 2 ? 'bg-white/[0.015]' : ''}`}
        >
          <span className="font-mono text-[12px] text-ink">
            {r.name}
            {r.required && <span className="ml-1 text-[#f87171]">*</span>}
          </span>
          <span className="truncate font-mono text-[11px] text-ink-muted">{r.type}</span>
        </div>
      ))}
    </div>
  );
}
