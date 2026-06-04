'use client';

import {cn} from '@/lib/cn';

export type StageState = 'queued' | 'running' | 'done' | 'failed';

export type Stage = {key: string; label: string; state: StageState};

// The 5 backend pipeline stages (spec §10.8). Real per-stage state arrives in
// Phase 4; for now they render idle/queued.
export const DEFAULT_STAGES: Stage[] = [
  {key: 'script', label: 'Script', state: 'queued'},
  {key: 'voice', label: 'Voice', state: 'queued'},
  {key: 'timing', label: 'Timing', state: 'queued'},
  {key: 'footage', label: 'Footage', state: 'queued'},
  {key: 'assemble', label: 'Assemble', state: 'queued'},
];

function StageDot({state, index}: {state: StageState; index: number}) {
  const base =
    'flex h-[38px] w-[38px] items-center justify-center rounded-full text-[13px] font-semibold transition-all duration-200 ease-out';
  if (state === 'done') {
    return (
      <div
        className={cn(
          base,
          'bg-grad-main text-white shadow-[0_0_16px_rgba(99,102,241,0.55)]',
        )}
      >
        ✓
      </div>
    );
  }
  if (state === 'running') {
    return (
      <div
        className={cn(
          base,
          'animate-ring-pulse border-2 border-accent-1 bg-accent-1/10 text-accent-3',
        )}
      >
        {index + 1}
      </div>
    );
  }
  if (state === 'failed') {
    return (
      <div className={cn(base, 'border border-bad/50 bg-bad/10 text-[#f87171]')}>!</div>
    );
  }
  return (
    <div className={cn(base, 'border border-glass bg-white/[0.02] text-ink-muted')}>
      {index + 1}
    </div>
  );
}

export function PipelineStepper({stages = DEFAULT_STAGES}: {stages?: Stage[]}) {
  return (
    <div className="flex items-start">
      {stages.map((stage, i) => (
        <div key={stage.key} className="flex flex-1 flex-col items-center">
          <div className="flex w-full items-center">
            {/* left connector */}
            <div
              className={cn(
                'h-[2px] flex-1 rounded-full transition-colors duration-300',
                i === 0
                  ? 'opacity-0'
                  : stages[i - 1].state === 'done'
                    ? 'bg-grad-main'
                    : 'bg-[var(--glass-border)]',
              )}
            />
            <StageDot state={stage.state} index={i} />
            {/* right connector */}
            <div
              className={cn(
                'h-[2px] flex-1 rounded-full transition-colors duration-300',
                i === stages.length - 1
                  ? 'opacity-0'
                  : stage.state === 'done'
                    ? 'bg-grad-main'
                    : 'bg-[var(--glass-border)]',
              )}
            />
          </div>
          <div
            className={cn(
              'mt-2 font-ui text-[12px] font-medium',
              stage.state === 'queued' ? 'text-ink-muted' : 'text-ink-secondary',
            )}
          >
            {stage.label}
          </div>
        </div>
      ))}
    </div>
  );
}
