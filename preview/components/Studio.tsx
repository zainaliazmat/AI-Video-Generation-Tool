'use client';

import {useEffect, useState} from 'react';
import {motion} from 'framer-motion';
import {toast} from 'sonner';
import type {Spec} from '@remotion-src/schema';
import {PlayerClient} from './PlayerClient';
import {TopicInput} from './TopicInput';
import {
  PipelineStepper,
  DEFAULT_STAGES,
  type Stage,
  type StageState,
} from './PipelineStepper';
import {RenderControls} from './RenderControls';
import {ProjectList} from './HistoryList';
import {Badge, Eyebrow} from './ui';
import type {ProjectMeta} from '@/lib/projects';
import {FootageGate, type GateScene} from './FootageGate';

const freshStages = (): Stage[] => DEFAULT_STAGES.map((s) => ({...s, state: 'queued'}));

const rise = {
  initial: {opacity: 0, y: 12},
  animate: {opacity: 1, y: 0},
  transition: {type: 'spring' as const, stiffness: 300, damping: 30},
};

export function Studio() {
  const [spec, setSpec] = useState<Spec | null>(null);
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stages, setStages] = useState<Stage[]>(freshStages);
  const [generating, setGenerating] = useState(false);
  const [genNonce, setGenNonce] = useState(0); // bump to remount the Player on a new spec
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [gateScenes, setGateScenes] = useState<GateScene[]>([]);
  const [editing, setEditing] = useState(false);

  async function refreshProjects(): Promise<ProjectMeta[]> {
    const r = await fetch('/api/projects');
    const list: ProjectMeta[] = r.ok ? await r.json() : [];
    setProjects(list);
    return list;
  }

  async function openProject(id: string) {
    const r = await fetch(`/api/projects/${id}?t=${Date.now()}`);
    if (!r.ok) return;
    const {spec: s} = (await r.json()) as {spec: Spec};
    setSpec(s);
    setSelectedId(id);
    setSessionId(id);            // edits + footage gate target this session
    setGenNonce((n) => n + 1);
    try {
      const st = await fetch(`/api/session/${id}/state`).then((x) => x.json());
      setGateScenes(Array.isArray(st?.scenes) ? st.scenes : []);
    } catch {
      setGateScenes([]);
    }
  }

  async function deleteProject(id: string) {
    await fetch(`/api/projects/${id}`, {method: 'DELETE'});
    const list = await refreshProjects();
    if (id === selectedId) {
      if (list[0]) await openProject(list[0].id);
      else {
        setSpec(null);
        setSelectedId(null);
        setSessionId(null);
        setGateScenes([]);
      }
    }
  }

  useEffect(() => {
    refreshProjects().then((list) => {
      if (list[0]) return openProject(list[0].id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function generate(topic: string) {
    setGenerating(true);
    setStages(freshStages());
    const toastId = toast.loading('Generating video…', {
      description: 'script → voice → timing → footage → assemble',
    });

    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({topic}),
      });
      if (res.status === 409) {
        toast.error('A generation is already in progress', {id: toastId});
        return;
      }
      if (!res.ok || !res.body) {
        throw new Error(`Request failed (${res.status})`);
      }

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
            setStages((prev) =>
              prev.map((s) => (s.key === stage ? {...s, state} : s)),
            );
          } else if (msg.type === 'done') {
            finished = true;
            const sid = typeof msg.sid === 'string' ? msg.sid : null;
            const list = await refreshProjects();
            if (sid) await openProject(sid);
            const title = list.find((p) => p.id === sid)?.title ?? 'Untitled';
            toast.success('Video generated', {id: toastId, description: title});
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

  async function pick(scene: number, rank: number) {
    if (!sessionId || editing) return;
    setEditing(true);
    const toastId = toast.loading('Swapping clip…');
    try {
      const res = await fetch(`/api/session/${sessionId}/edit`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({op: 'pick', scene, rank}),
      });
      if (res.status === 409) {
        toast.error('An edit is already in progress', {id: toastId});
        return;
      }
      const json = await res.json();
      if (!res.ok || json?.ok === false) throw new Error(json?.error ?? `HTTP ${res.status}`);
      // re-highlight from the edit response (no second /state fetch)
      setGateScenes((prev) =>
        prev.map((s) =>
          s.index === json.scene
            ? {...s, candidates: s.candidates.map((c) => ({...c, selected: c.rank === json.selectedRank}))}
            : s,
        ),
      );
      // reload spec into the live Player (instant); export MP4 is now stale
      const r = await fetch(`/api/projects/${sessionId}?t=${Date.now()}`);
      setSpec((await r.json()).spec);
      setGenNonce((n) => n + 1);
      toast.success('Clip swapped — preview updated', {id: toastId, description: 'Re-render to export the MP4.'});
    } catch (e) {
      toast.error('Swap failed', {id: toastId, description: e instanceof Error ? e.message : 'edit failed'});
    } finally {
      setEditing(false);
    }
  }

  // re_query replaces the candidate pool and upload binds an off-pool clip, so neither
  // can be re-highlighted optimistically from the response — re-fetch authoritative state.
  async function refreshAfterEdit(sid: string) {
    try {
      const st = await fetch(`/api/session/${sid}/state`).then((x) => x.json());
      if (Array.isArray(st?.scenes)) setGateScenes(st.scenes);
    } catch {
      /* keep the prior gate on a transient state error */
    }
    const r = await fetch(`/api/projects/${sid}?t=${Date.now()}`);
    setSpec((await r.json()).spec);
    setGenNonce((n) => n + 1);
  }

  async function reQuery(scene: number, query: string) {
    if (!sessionId || editing) return;
    setEditing(true);
    const toastId = toast.loading('Re-querying footage…');
    try {
      const res = await fetch(`/api/session/${sessionId}/edit`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({op: 're_query', scene, query}),
      });
      if (res.status === 409) {
        toast.error('An edit is already in progress', {id: toastId});
        return;
      }
      const json = await res.json();
      if (!res.ok || json?.ok === false) throw new Error(json?.error ?? `HTTP ${res.status}`);
      await refreshAfterEdit(sessionId);
      toast.success('Footage re-queried — preview updated', {
        id: toastId,
        description: 'Re-render to export the MP4.',
      });
    } catch (e) {
      toast.error('Re-query failed', {id: toastId, description: e instanceof Error ? e.message : 'edit failed'});
    } finally {
      setEditing(false);
    }
  }

  async function upload(scene: number, file: File) {
    if (!sessionId || editing) return;
    setEditing(true);
    const toastId = toast.loading('Uploading footage…');
    try {
      const form = new FormData();
      form.append('op', 'upload');
      form.append('scene', String(scene));
      form.append('file', file);
      // no content-type header — the browser sets the multipart boundary
      const res = await fetch(`/api/session/${sessionId}/edit`, {method: 'POST', body: form});
      if (res.status === 409) {
        toast.error('An edit is already in progress', {id: toastId});
        return;
      }
      const json = await res.json();
      if (!res.ok || json?.ok === false) throw new Error(json?.error ?? `HTTP ${res.status}`);
      await refreshAfterEdit(sessionId);
      toast.success('Upload bound — preview updated', {id: toastId, description: 'Re-render to export the MP4.'});
    } catch (e) {
      toast.error('Upload failed', {id: toastId, description: e instanceof Error ? e.message : 'edit failed'});
    } finally {
      setEditing(false);
    }
  }

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
            <TopicInput onGenerate={generate} busy={generating} />
          </motion.div>

          <motion.div
            {...rise}
            transition={{...rise.transition, delay: 0.08}}
            className="glass rounded-xl p-5"
          >
            <div className="flex items-center justify-between">
              <Eyebrow>Pipeline</Eyebrow>
              {generating ? (
                <Badge tone="blue" dot>
                  Running
                </Badge>
              ) : (
                <Badge tone="dim">Idle</Badge>
              )}
            </div>
            <div className="mt-5 px-1">
              <PipelineStepper stages={stages} />
            </div>
            <p className="mt-4 font-ui text-[12px] text-ink-muted">
              {generating
                ? 'Running the pipeline locally — this takes a couple of minutes on CPU.'
                : 'Enter a topic above and hit Generate to run the full pipeline.'}
            </p>
          </motion.div>

          {spec && selectedId && (
            <motion.div {...rise} transition={{...rise.transition, delay: 0.12}}>
              <RenderControls key={selectedId} spec={spec} projectId={selectedId} onRendered={refreshProjects} />
            </motion.div>
          )}

          {spec && gateScenes.length > 0 && (
            <motion.div {...rise} transition={{...rise.transition, delay: 0.14}}>
              <FootageGate
                scenes={gateScenes}
                busy={editing}
                onPick={pick}
                onRequery={reQuery}
                onUpload={upload}
              />
            </motion.div>
          )}

          <motion.div {...rise} transition={{...rise.transition, delay: 0.16}}>
            <ProjectList
              projects={projects}
              selectedId={selectedId}
              onOpen={openProject}
              onDelete={deleteProject}
            />
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
              {spec ? (
                <PlayerClient key={genNonce} spec={spec} />
              ) : (
                <div className="flex aspect-[1080/1920] items-center justify-center p-6 text-center font-ui text-[13px] text-ink-muted">
                  No videos yet — generate one to get started.
                </div>
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
