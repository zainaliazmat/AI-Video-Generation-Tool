'use client';

import {useEffect, useState} from 'react';
import {motion} from 'framer-motion';
import type {Spec} from '@remotion-src/schema';
import {PlayerClient} from './PlayerClient';
import {TopicInput} from './TopicInput';
import {PipelineStepper} from './PipelineStepper';
import {RenderControls, type RenderRecord} from './RenderControls';
import {HistoryList} from './HistoryList';
import {Badge, Eyebrow} from './ui';

const rise = {
  initial: {opacity: 0, y: 12},
  animate: {opacity: 1, y: 0},
  transition: {type: 'spring' as const, stiffness: 300, damping: 30},
};

export function Studio() {
  const [spec, setSpec] = useState<Spec | null>(null);
  const [failed, setFailed] = useState(false);
  const [history, setHistory] = useState<RenderRecord[]>([]);

  useEffect(() => {
    const ac = new AbortController();
    fetch('/sample-spec.json', {signal: ac.signal})
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((s: Spec) => setSpec(s))
      .catch((e) => {
        if (ac.signal.aborted) return;
        console.error('Failed to load sample-spec.json:', e);
        setFailed(true);
      });
    return () => ac.abort();
  }, []);

  return (
    <main className="relative z-[1] mx-auto max-w-[1040px] px-7 py-10 sm:px-8 sm:py-14">
      {/* Header */}
      <motion.header {...rise}>
        <Eyebrow>Faceless Video Studio</Eyebrow>
        <h1 className="mt-2 max-w-[18ch] font-ui text-[clamp(32px,5vw,52px)] font-semibold leading-[1.05] tracking-[-0.03em] text-ink">
          Preview the cut, then render it locally.
        </h1>
        <p className="mt-3 max-w-[52ch] font-ui text-[15px] leading-relaxed text-ink-secondary">
          Scrub the composition in real time, then export a 1080×1920 MP4 — voiceover,
          stock footage, and word-by-word captions, all rendered on your machine.
        </p>
      </motion.header>

      <div className="mt-9 grid grid-cols-1 gap-5 lg:grid-cols-[1fr_330px]">
        {/* Left column — controls */}
        <div className="flex flex-col gap-5">
          <motion.div {...rise} transition={{...rise.transition, delay: 0.04}}>
            <TopicInput />
          </motion.div>

          <motion.div
            {...rise}
            transition={{...rise.transition, delay: 0.08}}
            className="glass rounded-xl p-5"
          >
            <div className="flex items-center justify-between">
              <Eyebrow>Pipeline</Eyebrow>
              <Badge tone="dim">Idle</Badge>
            </div>
            <div className="mt-5 px-1">
              <PipelineStepper />
            </div>
            <p className="mt-4 font-ui text-[12px] text-ink-muted">
              The 5-stage backend runs here once it lands in Phase 4.
            </p>
          </motion.div>

          {spec && (
            <motion.div {...rise} transition={{...rise.transition, delay: 0.12}}>
              <RenderControls
                spec={spec}
                onComplete={(r) => setHistory((h) => [r, ...h])}
              />
            </motion.div>
          )}

          <motion.div {...rise} transition={{...rise.transition, delay: 0.16}}>
            <HistoryList records={history} />
          </motion.div>
        </div>

        {/* Right column — live preview */}
        <motion.div
          {...rise}
          transition={{...rise.transition, delay: 0.1}}
          className="lg:sticky lg:top-10 lg:self-start"
        >
          <div className="glass rounded-xl p-3">
            <div className="mb-3 flex items-center justify-between px-1">
              <Eyebrow>Live preview</Eyebrow>
              {spec && (
                <span className="font-mono text-[11px] tabular-nums text-ink-muted">
                  {(spec.meta.durationInFrames / spec.meta.fps).toFixed(1)}s ·{' '}
                  {spec.meta.fps}fps
                </span>
              )}
            </div>
            <div className="overflow-hidden rounded-[var(--radius-md)] bg-black">
              {failed ? (
                <div className="flex aspect-[1080/1920] items-center justify-center p-6 text-center font-ui text-[13px] text-ink-muted">
                  Could not load sample-spec.json. Run{' '}
                  <code className="mx-1 font-mono">npm run copy-assets</code> in preview/.
                </div>
              ) : spec ? (
                <PlayerClient spec={spec} />
              ) : (
                <div className="aspect-[1080/1920] w-full animate-pulse-dot bg-white/[0.03]" />
              )}
            </div>
            {spec && (
              <div className="truncate px-2 pb-1 pt-3 font-ui text-[13px] font-medium text-ink-secondary">
                {spec.meta.title}
              </div>
            )}
          </div>
        </motion.div>
      </div>
    </main>
  );
}
