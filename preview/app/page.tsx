'use client';

import {useCallback, useEffect, useState} from 'react';
import {useRouter} from 'next/navigation';
import {toast} from 'sonner';
import {Eyebrow, Badge, Button} from '@/components/ui';
import {
  PipelineStepper,
  DEFAULT_STAGES,
  type Stage,
  type StageState,
} from '@/components/PipelineStepper';
import {ProjectList} from '@/components/HistoryList';
import type {ProjectMeta} from '@/lib/projects';

// Studio v2 Home (PRD §5 + §10.8). A topic bar that kicks the backend pipeline via
// /api/generate (SSE), shows a live stepper, then routes into the per-video hub at
// /video/[sid]. Below: the project library as "Recents", each item opening the hub.
const freshStages = (): Stage[] => DEFAULT_STAGES.map((s) => ({...s, state: 'queued'}));

export default function Home() {
  const router = useRouter();
  const [topic, setTopic] = useState('');
  const [generating, setGenerating] = useState(false);
  const [stages, setStages] = useState<Stage[]>(freshStages);
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
    setStages(freshStages());
    const toastId = toast.loading('Generating video…', {
      description: 'script → voice → timing → footage → assemble',
    });

    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({topic: t}),
      });
      if (res.status === 409) {
        toast.error('A generation is already in progress', {id: toastId});
        return;
      }
      if (!res.ok || !res.body) throw new Error(`Request failed (${res.status})`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;

      for (;;) {
        const {value, done} = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, {stream: true});
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const f of frames) {
          const line = f.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          let msg: {type: string; [k: string]: unknown};
          try {
            msg = JSON.parse(line.slice(6));
          } catch {
            continue;
          }
          if (msg.type === 'stage') {
            const stage = msg.stage as string;
            const state = msg.state as StageState;
            setStages((prev) => prev.map((s) => (s.key === stage ? {...s, state} : s)));
          } else if (msg.type === 'done') {
            finished = true;
            const sid = typeof msg.sid === 'string' ? msg.sid : null;
            toast.success('Video generated', {id: toastId});
            if (sid) {
              router.push('/video/' + sid);
              return;
            }
          } else if (msg.type === 'error') {
            finished = true;
            throw new Error(String(msg.message));
          }
        }
      }
      if (!finished) toast.dismiss(toastId);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Generation failed';
      setStages((prev) =>
        prev.map((s) => (s.state === 'running' ? {...s, state: 'failed'} : s)),
      );
      toast.error('Generation failed', {id: toastId, description: message});
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
        <Button onClick={generate} disabled={generating} className="shrink-0">
          {generating ? 'Generating…' : 'Generate'}
        </Button>
      </div>
      <p className="mx-auto mt-2 max-w-[640px] px-1 text-center font-ui text-[12px] text-ink-muted">
        Runs the full pipeline on your machine — a couple of minutes on CPU. All local, all free.
      </p>

      {/* Live pipeline while generating */}
      {generating && (
        <div className="glass mx-auto mt-6 max-w-[640px] rounded-[var(--radius-xl)] p-5">
          <div className="flex items-center justify-between">
            <Eyebrow>Pipeline</Eyebrow>
            <Badge tone="blue" dot>
              Running
            </Badge>
          </div>
          <div className="mt-5 px-1">
            <PipelineStepper stages={stages} />
          </div>
          <p className="mt-4 font-ui text-[12px] text-ink-muted">
            Generating locally — you’ll land on the editing hub when it’s done.
          </p>
        </div>
      )}

      {/* Recents — the project library */}
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
