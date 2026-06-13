// Studio v2/v3 — client types mirroring the backend gate CLIs.
// The v2 types (ScriptGate, VoiceGate, etc.) are display contracts; the
// authoritative shapes live in Python.
// Studio v3 M6 types (GateState, SessionState, etc.) are the normative data
// contract for the new staged-flow pages.

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

// M2 amend 4: out-of-band scripts ride a `bandMiss` (camelCase) on the read
// payload — `requested` is the [min,max] beat band, `got` is the actual count.
// null when the script landed in-band. Drives the T3 warn pill.
export type BandMiss = {requested: [number, number]; got: number};

export type ScriptGate = {
  ok: boolean;
  sid: string;
  title: string;
  beats: ScriptBeat[];
  sources: {url: string; title: string | null}[];
  verifyReport: {text: string; verdict: string}[];
  factFloor: FactFloor;
  bandMiss?: BandMiss | null;
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
// F-5: the applied-patch event log. version is derived server-side (1 + history rows);
// revertableSeq is the only seq the LIFO undo will accept (newest un-reverted patch).
export type HistoryEntry = {seq: number; kind: 'patch' | 'revert'; diff: DiffLine[]; reverted: boolean; revertsSeq: number | null; createdAt: string};
export type AssembleHistory = {version: number; revertableSeq: number | null; history: HistoryEntry[]};
export type AssembleGate = {ok: boolean; sid: string; theme: Record<string, unknown>; scenes: AssembleScene[]} & AssembleHistory;
export type ChatResult = {ok: boolean; ops: PatchOp[]; reply: string; diff: DiffLine[]; valid: boolean};

// ---------------------------------------------------------------------------
// Studio v3 M6 — typed SessionState data contract (normative)
// ---------------------------------------------------------------------------

export type GateState = 'awaiting_approval' | 'approved' | 'reopened' | 'stale';
export interface Gate {state: GateState; approved_at: string | null}
export type GatesDict = Partial<Record<'script' | 'voice' | 'scenes' | 'assemble', Gate>>;

export interface Candidate {
  rank: number;
  thumbUrl: string;
  query: string;
  durationFrames: number;
  selected: boolean;
}
export interface FootageProvenance {
  source: 'auto' | 'pick' | 're_query' | 'uploaded';
  query: string | null;
  rank: number | null;
  pexelsId: number | null;
  pexelsUrl: string | null;
}
export interface TemplateOverride {value: string; source: string; pickedRank: number | null}
export interface BackgroundPool {rows: Candidate[]; poolError: string | null}
export interface BackgroundProvenance {
  source: string;
  pickedRank: number | null;
  query: string | null;
  pexelsId: number | null;
  pexelsUrl: string | null;
  updatedAt: string;
}
export interface LastPick {autoRank: number; humanRank: number}
export interface SceneState {
  index: number;
  template: string;
  needsFootage: boolean;
  beatText: string | null;
  durationInFrames: number | null;
  candidates: Candidate[];
  provenance: FootageProvenance | null;
  eligibleTemplates: string[];
  templateOverride: TemplateOverride | null;
  backgroundPool: BackgroundPool;
  backgroundProvenance: BackgroundProvenance | null;
  pickLogCount: number;
  lastPick: LastPick | null;
}
/** scenes:[] before the spec is generated (partial pre-spec state) */
export interface SessionState {
  sid: string;
  scenes: SceneState[];
  gates: GatesDict;
  autoRun: boolean;
}
export interface ReopenPreview {
  gate: string;
  reruns: string[];
  staleGates: string[];
}

// ---------------------------------------------------------------------------

async function j<T>(res: Response): Promise<T> {
  const data = await res.json();
  if (!res.ok) throw new Error((data && data.error) || `${res.status}`);
  return data as T;
}

// F-6: the style-memory manager doc (repo-level, cross-video by design).
export type StyleMemoryDoc = {
  examples: {index: number; before: string; after: string; pinned: boolean}[];
  guidance: {index: number; text: string; pinned: boolean}[];
  caps: {examples: number; guidance: number};
};

export const studio = {
  script: {
    read: (id: string) => fetch(`/api/session/${id}/script`).then(j<ScriptGate>),
    op: (id: string, body: Record<string, unknown>) =>
      fetch(`/api/session/${id}/script`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)}).then(j<ScriptGate & {regenerated?: boolean; approved?: boolean}>),
    styleMemory: (id: string, body: {op: 'style_memory_read'} | {op: 'style_memory_pin'; kind: 'example' | 'guidance'; index: number; value: boolean} | {op: 'style_memory_delete'; kind: 'example' | 'guidance'; index: number}) =>
      fetch(`/api/session/${id}/script`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)}).then(j<{ok: boolean; styleMemory: StyleMemoryDoc}>),
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
      fetch(`/api/session/${id}/assemble`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({op: 'apply', patch})}).then(j<{ok: boolean; diff: DiffLine[]} & AssembleHistory>),
    revert: (id: string, seq: number) =>
      fetch(`/api/session/${id}/assemble`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({op: 'revert', seq})}).then(j<{ok: boolean; reverted: number} & AssembleHistory>),
  },
  footage: {
    state: (id: string) => fetch(`/api/session/${id}/state`).then(j<SessionState>),
    suggest: (id: string, scene: number) =>
      fetch(`/api/session/${id}/footage/suggest`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({scene})}).then(j<{ok: boolean; scene: number; query: string; raw: string}>),
  },
  project: (id: string) => fetch(`/api/projects/${id}`).then(j<{spec: any; sources: any}>),

  // Studio v3 M6 — session client.  Returns the raw streaming Response for
  // start/approve so the caller drives parsing via readSse (lib/sse.ts).
  session: {
    /** POST /api/session/start — returns the raw SSE streaming Response. */
    start: (
      topic: string,
      opts?: {autoRun?: boolean; targetLength?: number},
    ): Promise<Response> =>
      fetch('/api/session/start', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({topic, ...(opts ?? {})}),
      }),

    /** POST /api/session/[id]/approve — returns the raw SSE streaming Response. */
    approve: (
      id: string,
      gate: string,
      opts?: {voice?: string; speed?: number},
    ): Promise<Response> =>
      fetch(`/api/session/${id}/approve`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({gate, ...(opts ?? {})}),
      }),

    /** GET /api/session/[id]/state — typed SessionState. */
    state: (id: string): Promise<SessionState> =>
      fetch(`/api/session/${id}/state`).then(j<SessionState>),

    /** POST /api/session/[id]/set-auto-run — toggle auto-run flag. */
    setAutoRun: (id: string, flag: boolean): Promise<{ok: boolean}> =>
      fetch(`/api/session/${id}/set-auto-run`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({flag}),
      }).then(j<{ok: boolean}>),

    /** POST /api/session/[id]/preview-reopen — preview gate-reopen side-effects. */
    previewReopen: (id: string, gate: string): Promise<ReopenPreview> =>
      fetch(`/api/session/${id}/preview-reopen`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({gate}),
      }).then(j<ReopenPreview>),
  },
};
