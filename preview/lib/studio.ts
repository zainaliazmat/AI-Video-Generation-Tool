// Studio v2 — client types mirroring the backend gate CLIs (session_script.py,
// session_voice.py, session_timing.py, session_assemble.py, session_state.py).
// These are display contracts; the authoritative shapes live in Python.

export type BeatFlag = 'supported' | 'unverified' | null;

export type ScriptBeat = {
  index: number;
  text: string;
  data: Record<string, unknown> | null;
  keywords: string | null;
  source: string | null;
  flag: BeatFlag;
  flagReason: string | null;
};

export type FactFloor = {supported: number; total: number; level: 'ok' | 'warn' | 'hard_fail'};

export type ScriptGate = {
  ok: boolean;
  sid: string;
  title: string;
  beats: ScriptBeat[];
  sources: {url: string; title: string | null}[];
  verifyReport: {text: string; verdict: string}[];
  factFloor: FactFloor;
};

export type Voice = {id: string; name: string; character: string; lang: string};
export type VoiceGate = {
  ok: boolean;
  voices: Voice[];
  current: {voice: string; speed: number} | null;
};

export type TimingWord = {index: number; text: string; startFrame: number; endFrame: number};
export type TimingLine = {index: number; text: string; start: number; end: number};
export type TimingGate = {ok: boolean; sid: string; words: TimingWord[]; lines: TimingLine[]};

export type PatchOp = {op: 'replace'; path: string; value: unknown};
export type DiffLine = {path: string; before: unknown; after: unknown};
export type AssembleScene = {index: number; template: string | null; hasMedia: boolean; transition: string | null};
export type AssembleGate = {ok: boolean; sid: string; theme: Record<string, unknown>; scenes: AssembleScene[]};
export type ChatResult = {ok: boolean; ops: PatchOp[]; reply: string; diff: DiffLine[]; valid: boolean};

async function j<T>(res: Response): Promise<T> {
  const data = await res.json();
  if (!res.ok) throw new Error((data && data.error) || `${res.status}`);
  return data as T;
}

export const studio = {
  script: {
    read: (id: string) => fetch(`/api/session/${id}/script`).then(j<ScriptGate>),
    op: (id: string, body: Record<string, unknown>) =>
      fetch(`/api/session/${id}/script`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)}).then(j<ScriptGate & {regenerated?: boolean; approved?: boolean}>),
  },
  voice: {
    list: (id: string) => fetch(`/api/session/${id}/voice`).then(j<VoiceGate>),
    op: (id: string, body: Record<string, unknown>) =>
      fetch(`/api/session/${id}/voice`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)}).then(j<any>),
  },
  timing: {
    read: (id: string) => fetch(`/api/session/${id}/timing`).then(j<TimingGate>),
    fixWord: (id: string, index: number, text: string) =>
      fetch(`/api/session/${id}/timing`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({op: 'fix_word', index, text})}).then(j<TimingGate>),
  },
  assemble: {
    read: (id: string) => fetch(`/api/session/${id}/assemble`).then(j<AssembleGate>),
    chat: (id: string, message: string) =>
      fetch(`/api/session/${id}/assemble`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({op: 'chat', message})}).then(j<ChatResult>),
    apply: (id: string, patch: PatchOp[]) =>
      fetch(`/api/session/${id}/assemble`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({op: 'apply', patch})}).then(j<{ok: boolean; diff: DiffLine[]}>),
  },
  footage: {
    state: (id: string) => fetch(`/api/session/${id}/state`).then(j<any>),
    suggest: (id: string, scene: number) =>
      fetch(`/api/session/${id}/footage/suggest`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({scene})}).then(j<{ok: boolean; scene: number; query: string; raw: string}>),
  },
  project: (id: string) => fetch(`/api/projects/${id}`).then(j<{spec: any; sources: any}>),
};
