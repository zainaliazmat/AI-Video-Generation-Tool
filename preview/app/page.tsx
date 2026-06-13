'use client';

import {useCallback, useEffect, useState} from 'react';
import {useRouter} from 'next/navigation';
import {Eyebrow, Button} from '@/components/ui';
import {ProjectList} from '@/components/HistoryList';
import type {ProjectMeta} from '@/lib/projects';
import {studio} from '@/lib/studio';
import {readSse} from '@/lib/sse';
import {LENHINT, DEFAULT_TARGET_LENGTH, type TargetLength} from '@/lib/topicScreen';
import {cn} from '@/lib/cn';

// Studio v3 T1 Home — Topic screen with length presets + auto-run toggle.
//
// Generate flow (ruling 2):
//   1. POST studio.session.start(topic, {autoRun, targetLength}) → SSE stream.
//   2. On {type:'sid', sid} → router.push('/video/' + sid + '/script') IMMEDIATELY.
//      The script segment may still be running server-side; the script page polls
//      /state until gates.script === 'awaiting_approval'.  (See T3.)
//   3. Error before sid → show failed state inline (no toast redirect).
//
// /api/generate is UNTOUCHED (OV-15 — survives for autopilot/QA).

const LENGTH_CHIPS: {value: TargetLength; label: string}[] = [
  {value: 30, label: '30 s'},
  {value: 60, label: '60 s'},
  {value: 180, label: '3 min'},
  {value: 300, label: '5 min'},
];

export default function Home() {
  const router = useRouter();
  const [topic, setTopic] = useState('');
  const [targetLength, setTargetLength] = useState<TargetLength>(DEFAULT_TARGET_LENGTH);
  const [autoRun, setAutoRun] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectMeta[]>([]);

  const refreshProjects = useCallback(async () => {
    try {
      const r = await fetch('/api/projects');
      const list: ProjectMeta[] = r.ok ? await r.json() : [];
      setProjects(list);
    } catch {
      setProjects([]);
    }
  }, []);

  useEffect(() => {
    refreshProjects();
  }, [refreshProjects]);

  async function generate() {
    const t = topic.trim();
    if (!t || generating) return;
    setGenerating(true);
    setStartError(null);

    try {
      const res = await studio.session.start(t, {autoRun, targetLength});

      if (!res.ok || !res.body) {
        throw new Error(`Request failed (${res.status})`);
      }

      let sidReceived = false;

      await readSse(res, (event) => {
        if (event.type === 'sid') {
          sidReceived = true;
          // Ruling 2 — navigate IMMEDIATELY on sid; script page handles the
          // interstitial while the backend finishes the script segment.
          router.push('/video/' + event.sid + '/script');
          // readSse keeps consuming but the navigation has happened; any further
          // events are benign (they arrive before the route change completes).
          return;
        }

        if (event.type === 'error' && !sidReceived) {
          // Error before a sid: show failed state on this screen.
          const msg = event.error ?? event.message ?? 'Script generation failed';
          setStartError(msg);
        }
      });
    } catch (e) {
      if (!generating) return; // unmounted / aborted
      const msg = e instanceof Error ? e.message : 'Generation failed';
      setStartError(msg);
    } finally {
      setGenerating(false);
    }
  }

  return (
    <main className="relative z-[1] mx-auto max-w-[860px] px-6 py-12 sm:py-16">
      {/* Hero */}
      <div className="text-center">
        <Eyebrow>Faceless Video Studio</Eyebrow>
        <h1 className="mx-auto mt-3 max-w-[20ch] font-ui text-[clamp(30px,5vw,48px)] font-semibold leading-[1.06] tracking-[-0.03em] text-ink">
          Type a topic. Get a faceless video.
        </h1>
        <p className="mx-auto mt-3 max-w-[48ch] font-ui text-[15px] leading-relaxed text-ink-secondary">
          Script, voiceover, stock footage, and word-by-word captions — generated and
          rendered locally, then tuned scene by scene.
        </p>
      </div>

      {/* Topic bar — glass */}
      <div className="glass glass-hover mx-auto mt-8 flex max-w-[640px] flex-col gap-3 rounded-[var(--radius-xl)] p-3 sm:flex-row sm:items-center">
        <input
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && generate()}
          disabled={generating}
          placeholder="3 facts about deep sea creatures…"
          className="flex-1 rounded-[var(--radius-md)] border border-transparent bg-white/[0.03] px-4 py-3 font-ui text-[15px] text-ink outline-none transition-all duration-150 ease-out placeholder:text-ink-muted focus:border-[var(--glass-border-active)] focus:bg-white/[0.05] focus:shadow-[0_0_0_4px_rgba(99,102,241,0.12)] disabled:opacity-50"
        />
        <Button onClick={generate} disabled={generating || !topic.trim()} className="shrink-0">
          {generating ? 'Generating…' : 'Generate'}
        </Button>
      </div>

      {/* Length preset chips (#lenchips) — mock §1 */}
      <div className="mx-auto mt-4 max-w-[640px] px-1">
        <p className="mb-2 font-ui text-[12px] font-semibold text-ink-secondary">Target length</p>
        <div className="flex flex-wrap gap-[7px]" id="lenchips" role="group" aria-label="Target length">
          {LENGTH_CHIPS.map(({value, label}) => (
            <button
              key={value}
              type="button"
              data-len={value}
              onClick={() => setTargetLength(value)}
              aria-pressed={targetLength === value}
              className={cn(
                'rounded-full border px-[14px] py-[7px] font-ui text-[12px] font-semibold',
                'transition-all duration-200',
                targetLength === value
                  ? 'border-[rgba(94,92,230,0.4)] bg-[var(--tint-soft,rgba(94,92,230,0.12))] text-[var(--accent-1)]'
                  : 'border-transparent bg-white/[0.12] text-ink-secondary hover:bg-white/[0.2]',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {/* Length hint line (#lenhint) — exact strings from LENHINT map */}
        <p
          id="lenhint"
          className="mt-2 font-ui text-[12px] text-ink-muted"
        >
          {LENHINT[targetLength]}
        </p>
      </div>

      {/* Auto-run toggle — mock §0 top bar. Shown inline on the topic screen per
          the task spec (keep it if clean; skip gate stepper bar until /video pages). */}
      <div className="mx-auto mt-4 max-w-[640px] px-1">
        <div
          role="switch"
          aria-checked={autoRun}
          aria-label="Auto-run"
          tabIndex={0}
          onClick={() => setAutoRun((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setAutoRun((v) => !v);
            }
          }}
          className={cn(
            'inline-flex cursor-pointer select-none items-center gap-2',
            'font-ui text-[12px] font-semibold',
            autoRun ? 'text-ink' : 'text-ink-muted',
            'transition-colors duration-[250ms]',
          )}
        >
          {/* Toggle pill */}
          <span
            className={cn(
              'relative h-[18px] w-[30px] flex-none rounded-full transition-colors duration-[250ms]',
              autoRun ? 'bg-[var(--accent-1)]' : 'bg-white/[0.14]',
            )}
            aria-hidden="true"
          >
            <span
              className={cn(
                'absolute top-[2.5px] h-[13px] w-[13px] rounded-full bg-white opacity-85',
                'transition-transform duration-[250ms]',
                autoRun ? 'left-[3px] translate-x-[11px]' : 'left-[3px]',
              )}
            />
          </span>
          Auto-run
        </div>
        <p className="mt-1 font-ui text-[11px] text-ink-muted">
          approves every gate with defaults — you can still edit after
        </p>
      </div>

      {/* Generating affordance — covers the ~instant gap between click and sid */}
      {generating && (
        <div className="glass mx-auto mt-6 max-w-[640px] rounded-[var(--radius-xl)] p-5 text-center">
          <p className="font-ui text-[13px] text-ink-secondary">
            Starting session…
          </p>
          <p className="mt-1 font-ui text-[12px] text-ink-muted">
            You'll land on the script gate in a moment.
          </p>
        </div>
      )}

      {/* Error state — script failed before sid arrived */}
      {startError && !generating && (
        <div className="glass mx-auto mt-6 max-w-[640px] rounded-[var(--radius-xl)] border border-[rgba(255,80,80,0.2)] p-5">
          <p className="font-ui text-[13px] font-semibold text-[#ff5050]">
            draft — script failed
          </p>
          <p className="mt-1 font-ui text-[12px] text-ink-muted">{startError}</p>
          <div className="mt-4">
            <Button
              onClick={() => {
                setStartError(null);
                generate();
              }}
              disabled={!topic.trim()}
            >
              Retry
            </Button>
          </div>
        </div>
      )}

      {/* Recents — the project library (T11 handles stub metas) */}
      <div className="mx-auto mt-10 max-w-[640px]">
        <ProjectList
          projects={projects}
          selectedId={null}
          onOpen={(id) => router.push('/video/' + id)}
          onDelete={async (id) => {
            await fetch(`/api/projects/${id}`, {method: 'DELETE'});
            refreshProjects();
          }}
        />
      </div>
    </main>
  );
}
