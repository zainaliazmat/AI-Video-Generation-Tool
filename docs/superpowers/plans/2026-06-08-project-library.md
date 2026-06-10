# Project Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every generated/rendered video a persistent, re-openable project that survives refresh, route changes, and server restarts.

**Architecture:** The backend mints a stable per-run `id` and snapshots each run into `projects/<id>/` (`spec.json` + `sources.json` + `meta.json`, plus `video.mp4` after render). The per-run voiceover is namespaced (`voiceover_<id>.wav`) so nothing referenced gets overwritten — enabling pixel-perfect re-preview. The project list is a directory scan (no global index); projects are served via Next API routes (not mirrored into `public/`). The Player loads a selected project's spec via API; there is no root `spec.json` source of truth.

**Tech Stack:** Python 3.12 + pytest (backend pipeline), Next.js App Router / TypeScript (preview API + UI), Remotion CLI (render).

**Spec:** `docs/superpowers/specs/2026-06-08-project-library-design.md`

---

## File Structure

**Backend (Python):**
- Create `backend/pipeline/projects.py` — project id minting, paths, per-project writes (pure, testable).
- Create `backend/tests/test_projects.py` — unit tests for the above.
- Modify `backend/main.py` — mint id, namespaced voiceover, write project folder, emit id, stop writing root `spec.json`.
- Modify `backend/pipeline/assemble.py:131` — parametrize the voiceover path in `build_spec`.

**Frontend API (TypeScript):**
- Create `preview/lib/projects.ts` — shared `ProjectMeta` type + id validation + repo-path helpers.
- Create `preview/app/api/projects/route.ts` — `GET` list (directory scan).
- Create `preview/app/api/projects/[id]/route.ts` — `GET` spec, `DELETE` project.
- Create `preview/app/api/projects/[id]/video/route.ts` — `GET` stream MP4 (range support).
- Modify `preview/app/api/generate/route.ts` — emit `id` in the `done` event.
- Modify `preview/app/api/render/route.ts` — accept `id`, stage spec via `SPEC_PATH`, copy output into the project.
- Modify `preview/scripts/copy-assets.mjs` — drop the now-unused root-`spec.json` copy.

**Frontend UI:**
- Modify `preview/components/Studio.tsx` — server-backed project list, selection, empty state.
- Rewrite `preview/components/HistoryList.tsx` → project list with open / download / re-render / delete.
- Modify `preview/components/RenderControls.tsx` — render the selected project by `id`.

---

## Task 1: Backend — project id + paths module (pure logic, TDD)

**Files:**
- Create: `backend/pipeline/projects.py`
- Test: `backend/tests/test_projects.py`

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_projects.py
from datetime import datetime
from pathlib import Path

from pipeline import projects


def test_slugify_basic():
    assert projects.slugify("3 facts about Deep Sea Creatures!") == "3-facts-about-deep-sea-creatures"


def test_slugify_empty_falls_back():
    assert projects.slugify("!!!") == "video"


def test_slugify_truncates_to_max():
    out = projects.slugify("word " * 40)
    assert len(out) <= projects.SLUG_MAX
    assert not out.endswith("-")


def test_mint_project_id_format():
    now = datetime(2026, 6, 8, 14, 30)
    assert projects.mint_project_id("deep sea facts", now) == "20260608-1430-deep-sea-facts"


def test_mint_project_id_collision_suffixes():
    now = datetime(2026, 6, 8, 14, 30)
    taken = {"20260608-1430-deep-sea-facts"}
    got = projects.mint_project_id("deep sea facts", now, exists=lambda i: i in taken)
    assert got == "20260608-1430-deep-sea-facts-2"


def test_voiceover_name_namespaced():
    assert projects.voiceover_name("20260608-1430-x") == "voiceover_20260608-1430-x.wav"


def test_write_project_writes_three_files(tmp_path: Path):
    projects.write_project(
        tmp_path,
        "20260608-1430-x",
        spec_json='{"meta":{"title":"X"}}',
        sources={"facts": []},
        meta={"id": "20260608-1430-x", "title": "X"},
    )
    d = tmp_path / "projects" / "20260608-1430-x"
    assert (d / "spec.json").read_text() == '{"meta":{"title":"X"}}'
    assert '"facts"' in (d / "sources.json").read_text()
    assert '"id": "20260608-1430-x"' in (d / "meta.json").read_text()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && .venv/bin/python -m pytest tests/test_projects.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'pipeline.projects'`

- [ ] **Step 3: Write the implementation**

```python
# backend/pipeline/projects.py
"""Project library — per-generation snapshot directories under projects/.

Each generation gets a stable id (YYYYMMDD-HHMM-<topic-slug>) and its own folder
holding the render contract (spec.json), the grounding sidecar (sources.json) and a
list sidecar (meta.json). Media stays in the shared content-addressed assets pool;
the per-project voiceover is namespaced (voiceover_<id>.wav) so it is never
overwritten — which is what makes pixel-perfect re-preview possible.
"""
from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path
from typing import Callable

SLUG_MAX = 40


def slugify(topic: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", topic.lower()).strip("-")
    s = s[:SLUG_MAX].strip("-")
    return s or "video"


def mint_project_id(
    topic: str, now: datetime, *, exists: Callable[[str], bool] = lambda _id: False
) -> str:
    base = f"{now:%Y%m%d-%H%M}-{slugify(topic)}"
    if not exists(base):
        return base
    n = 2
    while exists(f"{base}-{n}"):
        n += 1
    return f"{base}-{n}"


def projects_root(repo_root: Path) -> Path:
    return Path(repo_root) / "projects"


def project_dir(repo_root: Path, project_id: str) -> Path:
    return projects_root(repo_root) / project_id


def voiceover_name(project_id: str) -> str:
    return f"voiceover_{project_id}.wav"


def write_project(
    repo_root: Path, project_id: str, *, spec_json: str, sources: dict, meta: dict
) -> Path:
    d = project_dir(repo_root, project_id)
    d.mkdir(parents=True, exist_ok=True)
    (d / "spec.json").write_text(spec_json, encoding="utf-8")
    (d / "sources.json").write_text(json.dumps(sources, indent=2), encoding="utf-8")
    (d / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return d
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && .venv/bin/python -m pytest tests/test_projects.py -v`
Expected: PASS (7 passed)

- [ ] **Step 5: Commit**

```bash
git add backend/pipeline/projects.py backend/tests/test_projects.py
git commit -m "feat(projects): id minting + per-project snapshot writer"
```

---

## Task 2: Backend — parametrize the voiceover path in `build_spec`

**Files:**
- Modify: `backend/pipeline/assemble.py:131`
- Test: `backend/tests/test_assemble.py`

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_assemble.py` (reuse the file's existing fixtures for `plan`, `offsets`, `words`, `clips`, `catalog`; if a `build_spec` test already exists, copy its setup):

```python
def test_build_spec_uses_custom_voiceover_path(plan, offsets, words, clips, catalog):
    spec = assemble.build_spec(
        plan, offsets, words, clips, catalog=catalog, fps=30,
        voiceover_rel="assets/voiceover_20260608-1430-x.wav",
    )
    assert spec.audio.voiceover == "assets/voiceover_20260608-1430-x.wav"


def test_build_spec_default_voiceover_path(plan, offsets, words, clips, catalog):
    spec = assemble.build_spec(plan, offsets, words, clips, catalog=catalog, fps=30)
    assert spec.audio.voiceover == "assets/voiceover.wav"
```

> If `test_assemble.py` builds its inputs inline rather than via fixtures, mirror that file's existing construction for these two tests instead of assuming fixtures.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && .venv/bin/python -m pytest tests/test_assemble.py -k voiceover -v`
Expected: FAIL — `build_spec() got an unexpected keyword argument 'voiceover_rel'`

- [ ] **Step 3: Implement the change**

In `backend/pipeline/assemble.py`, add a keyword param to `build_spec` (around line 78) and use it at line 131:

```python
def build_spec(
    plan, offsets, words, clips, *, catalog, fps,
    voiceover_rel: str = "assets/voiceover.wav",
):
    ...
        audio=Audio(voiceover=voiceover_rel, music=music, musicVolumeDb=-18.0),
```

> Keep the rest of `build_spec` unchanged; only the signature line and the `Audio(...)` line change.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && .venv/bin/python -m pytest tests/test_assemble.py -v`
Expected: PASS (existing assemble tests + the two new ones)

- [ ] **Step 5: Commit**

```bash
git add backend/pipeline/assemble.py backend/tests/test_assemble.py
git commit -m "feat(assemble): parametrize voiceover path in build_spec"
```

---

## Task 3: Backend — wire id, namespaced voiceover, project writes into `main.py`

**Files:**
- Modify: `backend/main.py`

This task is integration glue verified by the end-to-end run (Task 11), so it has no new unit test. Keep each edit minimal.

- [ ] **Step 1: Import the module and add an `on_project` hook to `run`**

At the top of `backend/main.py` with the other pipeline imports:

```python
from datetime import datetime
from pipeline import projects as projects_mod
```

Change the `run` signature to accept a project callback:

```python
def run(topic: str, fps: int = DEFAULT_FPS, on_stage=None, on_project=None):
```

- [ ] **Step 2: Mint the id and namespace the voiceover (top of `run`)**

Replace:

```python
    ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    voiceover = ASSETS_DIR / "voiceover.wav"
```

with:

```python
    ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    now = datetime.now()
    project_id = projects_mod.mint_project_id(
        topic, now,
        exists=lambda i: projects_mod.project_dir(REPO_ROOT, i).exists(),
    )
    voiceover = ASSETS_DIR / projects_mod.voiceover_name(project_id)
```

- [ ] **Step 3: Pass the namespaced path into `build_spec`**

Replace the `build_spec(...)` call in the assemble stage with:

```python
        spec = assemble_stage.build_spec(
            plan, offsets, words, clips, catalog=catalog, fps=fps,
            voiceover_rel=f"assets/{projects_mod.voiceover_name(project_id)}",
        )
```

- [ ] **Step 4: Write the project folder; stop writing root `spec.json`**

Replace the write block:

```python
        validate_stage.validate_spec(spec, catalog)  # fail fast before writing
        assemble_stage.write_spec(spec, SPEC_OUT)
        SOURCES_OUT.write_text(json.dumps(build_sources_sidecar(script_result), indent=2), encoding="utf-8")
        _log(f"      wrote {SPEC_OUT}  ({spec.meta.durationInFrames} frames @ {fps}fps)")
        _log(f"      wrote {SOURCES_OUT}  ({len(script_result.sources or [])} sources cited)")
        emit("assemble", "done")
        return spec
```

with:

```python
        validate_stage.validate_spec(spec, catalog)  # fail fast before writing
        sources = build_sources_sidecar(script_result)
        meta = {
            "id": project_id,
            "topic": topic,
            "title": spec.meta.title,
            "createdAt": int(now.timestamp() * 1000),
            "durationInFrames": spec.meta.durationInFrames,
            "fps": spec.meta.fps,
        }
        project_path = projects_mod.write_project(
            REPO_ROOT, project_id,
            spec_json=spec.model_dump_json(indent=2),
            sources=sources,
            meta=meta,
        )
        _log(f"      wrote {project_path}  ({spec.meta.durationInFrames} frames @ {fps}fps)")
        if on_project:
            on_project(project_id)
        emit("assemble", "done")
        return spec
```

> `Spec` is a Pydantic model (`backend/schema.py`), so `spec.model_dump_json(indent=2)` produces the same JSON `write_spec` did. The `SPEC_OUT` / `SOURCES_OUT` constants are now unused — leave them defined (harmless) or delete both; either is fine.

- [ ] **Step 5: Emit the id on the progress stream in `__main__`**

In the `if __name__ == "__main__":` block, extend the `--progress-json` wiring:

```python
    on_stage = None
    on_project = None
    if args.progress_json:
        def on_stage(key: str, state: str) -> None:
            print(f"PROGRESS {json.dumps({'stage': key, 'state': state})}", flush=True)

        def on_project(project_id: str) -> None:
            print(f"PROJECT {json.dumps({'id': project_id})}", flush=True)

    run(args.topic, args.fps, on_stage=on_stage, on_project=on_project)
```

- [ ] **Step 6: Verify the backend runs end-to-end (smoke)**

Run: `cd /home/zain-ali/Documents/AIVideoGenerationTool && backend/.venv/bin/python backend/main.py --topic "two facts about owls" --progress-json`
Expected: a `PROJECT {"id": "..."}` line on stdout near the end; `projects/<id>/spec.json`, `sources.json`, `meta.json` exist; `remotion/public/assets/voiceover_<id>.wav` exists.

- [ ] **Step 7: Commit**

```bash
git add backend/main.py
git commit -m "feat(main): snapshot each run into projects/<id> with namespaced voiceover"
```

---

## Task 4: Frontend — shared project lib (type + id validation)

**Files:**
- Create: `preview/lib/projects.ts`

- [ ] **Step 1: Write the module**

```typescript
// preview/lib/projects.ts
import path from 'node:path';

export type ProjectMeta = {
  id: string;
  topic: string;
  title: string;
  createdAt: number;
  durationInFrames: number;
  fps: number;
  hasRender: boolean; // derived from projects/<id>/video.mp4 existence
};

// id shape minted by the backend: YYYYMMDD-HHMM-<slug>. Validate before using an
// id in a filesystem path to prevent traversal (e.g. "../../etc").
const ID_RE = /^\d{8}-\d{4}-[a-z0-9-]+$/;

export function isValidProjectId(id: string): boolean {
  return ID_RE.test(id);
}

// The preview dev server's cwd is preview/; the repo root is its parent.
export function repoRoot(): string {
  return path.resolve(process.cwd(), '..');
}

export function projectsDir(): string {
  return path.join(repoRoot(), 'projects');
}

export function projectDir(id: string): string {
  return path.join(projectsDir(), id);
}
```

- [ ] **Step 2: Typecheck**

Run: `cd preview && npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add preview/lib/projects.ts
git commit -m "feat(projects-api): shared ProjectMeta type + id validation"
```

---

## Task 5: Frontend — `GET /api/projects` (directory-scan list)

**Files:**
- Create: `preview/app/api/projects/route.ts`

- [ ] **Step 1: Write the route**

```typescript
// preview/app/api/projects/route.ts
import {readdirSync, readFileSync, existsSync} from 'node:fs';
import path from 'node:path';
import {projectsDir, projectDir, type ProjectMeta} from '@/lib/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const dir = projectsDir();
  const out: ProjectMeta[] = [];
  if (existsSync(dir)) {
    for (const id of readdirSync(dir)) {
      const metaPath = path.join(projectDir(id), 'meta.json');
      if (!existsSync(metaPath)) continue; // skip incomplete/foreign folders
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
        out.push({
          ...meta,
          hasRender: existsSync(path.join(projectDir(id), 'video.mp4')),
        });
      } catch {
        // ignore a malformed meta.json — never let one bad folder break the list
      }
    }
  }
  out.sort((a, b) => b.createdAt - a.createdAt); // newest first
  return Response.json(out);
}
```

- [ ] **Step 2: Typecheck**

Run: `cd preview && npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Verify against the project created in Task 3**

Run (with the dev server up — see Task 11 for startup): `curl -s localhost:3100/api/projects | head -c 400`
Expected: a JSON array containing the owls project with `"hasRender": false` (no render yet).

- [ ] **Step 4: Commit**

```bash
git add preview/app/api/projects/route.ts
git commit -m "feat(projects-api): GET /api/projects directory-scan list"
```

---

## Task 6: Frontend — `GET`/`DELETE /api/projects/[id]`

**Files:**
- Create: `preview/app/api/projects/[id]/route.ts`

- [ ] **Step 1: Write the route**

```typescript
// preview/app/api/projects/[id]/route.ts
import {readFileSync, existsSync, rmSync} from 'node:fs';
import path from 'node:path';
import {isValidProjectId, projectDir, repoRoot} from '@/lib/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bad = (status: number, error: string) =>
  new Response(JSON.stringify({error}), {status, headers: {'content-type': 'application/json'}});

export async function GET(_req: Request, {params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  if (!isValidProjectId(id)) return bad(400, 'Invalid project id');
  const specPath = path.join(projectDir(id), 'spec.json');
  if (!existsSync(specPath)) return bad(404, 'Project not found');
  const spec = JSON.parse(readFileSync(specPath, 'utf-8'));
  const sourcesPath = path.join(projectDir(id), 'sources.json');
  const sources = existsSync(sourcesPath) ? JSON.parse(readFileSync(sourcesPath, 'utf-8')) : null;
  return Response.json({spec, sources});
}

export async function DELETE(_req: Request, {params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  if (!isValidProjectId(id)) return bad(400, 'Invalid project id');
  // Remove the project folder.
  rmSync(projectDir(id), {recursive: true, force: true});
  // Remove the namespaced voiceover from both asset roots (shared footage stays).
  const voiceover = `voiceover_${id}.wav`;
  for (const root of ['remotion/public/assets', 'preview/public/assets']) {
    rmSync(path.join(repoRoot(), root, voiceover), {force: true});
  }
  return Response.json({ok: true});
}
```

> Next.js 15 App Router (this project is on 15.5.19) passes `params` as a Promise — hence the `await params`.

- [ ] **Step 2: Typecheck**

Run: `cd preview && npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Verify GET**

Run: `curl -s localhost:3100/api/projects/<owls-id> | head -c 200`
Expected: `{"spec":{...},"sources":{...}}`.

- [ ] **Step 4: Commit**

```bash
git add preview/app/api/projects/[id]/route.ts
git commit -m "feat(projects-api): GET spec + DELETE project by id"
```

---

## Task 7: Frontend — `GET /api/projects/[id]/video` (range-aware MP4 stream)

**Files:**
- Create: `preview/app/api/projects/[id]/video/route.ts`

This mirrors the existing `preview/app/api/render/output/route.ts` (same `parseRange` / `toResponseBody` logic) but resolves the path per project.

- [ ] **Step 1: Write the route**

```typescript
// preview/app/api/projects/[id]/video/route.ts
import {createReadStream, statSync, existsSync} from 'node:fs';
import {Readable} from 'node:stream';
import path from 'node:path';
import {isValidProjectId, projectDir} from '@/lib/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseRange(range: string, size: number): {start: number; end: number} | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m) return null;
  const [, s, e] = m;
  if (s === '' && e === '') return null;
  let start: number;
  let end: number;
  if (s === '') {
    const n = Number(e);
    if (!Number.isFinite(n) || n <= 0) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(s);
    end = e === '' ? size - 1 : Number(e);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return null;
  return {start, end: Math.min(end, size - 1)};
}

function toResponseBody(stream: ReturnType<typeof createReadStream>, signal: AbortSignal) {
  stream.on('error', () => stream.destroy());
  if (signal.aborted) stream.destroy();
  else signal.addEventListener('abort', () => stream.destroy(), {once: true});
  return Readable.toWeb(stream) as ReadableStream;
}

export async function GET(req: Request, {params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  if (!isValidProjectId(id)) return new Response('Invalid id', {status: 400});
  const file = path.join(projectDir(id), 'video.mp4');
  if (!existsSync(file)) return new Response('Not rendered', {status: 404});

  const size = statSync(file).size;
  const rangeHeader = req.headers.get('range');
  const base = {'content-type': 'video/mp4', 'accept-ranges': 'bytes'};

  if (rangeHeader) {
    const r = parseRange(rangeHeader, size);
    if (!r) {
      return new Response('Invalid range', {status: 416, headers: {'content-range': `bytes */${size}`}});
    }
    const stream = createReadStream(file, {start: r.start, end: r.end});
    return new Response(toResponseBody(stream, req.signal), {
      status: 206,
      headers: {
        ...base,
        'content-range': `bytes ${r.start}-${r.end}/${size}`,
        'content-length': String(r.end - r.start + 1),
      },
    });
  }

  const stream = createReadStream(file);
  return new Response(toResponseBody(stream, req.signal), {
    status: 200,
    headers: {...base, 'content-length': String(size)},
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `cd preview && npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add preview/app/api/projects/[id]/video/route.ts
git commit -m "feat(projects-api): GET /api/projects/[id]/video range stream"
```

---

## Task 8: Frontend — generate route emits `id`; render route renders by `id`

**Files:**
- Modify: `preview/app/api/generate/route.ts`
- Modify: `preview/app/api/render/route.ts`

- [ ] **Step 1: Parse the `PROJECT` line and add `id` to the generate `done` event**

In `preview/app/api/generate/route.ts`, declare a holder near the stream's other locals (e.g. beside `let stdoutBuf = '';`):

```typescript
      let projectId: string | null = null;
```

In the stdout line loop, after the existing `PROGRESS ` handling, add a `PROJECT ` branch:

```typescript
          const p = line.indexOf('PROJECT ');
          if (p !== -1) {
            try {
              const evt = JSON.parse(line.slice(p + 'PROJECT '.length));
              if (evt && typeof evt.id === 'string') projectId = evt.id;
            } catch {
              /* ignore a partial PROJECT line */
            }
          }
```

In the `child.on('close', ...)` success branch, include the id:

```typescript
        if (code === 0) {
          await stageAssets();
          send({type: 'done', id: projectId});
        } else {
```

> The `done` event no longer needs `spec: '/spec.json'`; the client now loads the spec via `/api/projects/<id>`.

- [ ] **Step 2: Render the selected project by id**

In `preview/app/api/render/route.ts`, read the id from the POST body at the top of `POST`:

```typescript
export async function POST(req: Request) {
  let id = '';
  try {
    const body = await req.json();
    id = typeof body?.id === 'string' ? body.id.trim() : '';
  } catch {
    id = '';
  }
  if (!id) {
    return new Response(JSON.stringify({error: 'A project "id" is required to render.'}), {
      status: 400, headers: {'content-type': 'application/json'},
    });
  }
  if (rendering) {
    // ...existing 409 unchanged...
```

Stage that project's spec into the renderer via the `SPEC_PATH` env `copy-spec` already honors. Change the spawn to pass it:

```typescript
      child = spawn('npm', ['run', 'render'], {
        cwd: REMOTION_DIR,
        env: {...process.env, SPEC_PATH: `projects/${id}/spec.json`},
        shell: false,
        detached: true,
      });
```

- [ ] **Step 3: Copy the rendered MP4 into the project on success**

Add the import at the top of `preview/app/api/render/route.ts`:

```typescript
import {copyFileSync, mkdirSync} from 'node:fs';
```

In the `child.on('close', ...)` success branch, copy `out/video.mp4` into `projects/<id>/`:

```typescript
      child.on('close', (code) => {
        if (code === 0) {
          try {
            const src = path.resolve(REMOTION_DIR, 'out', 'video.mp4');
            const destDir = path.resolve(REMOTION_DIR, '..', 'projects', id);
            mkdirSync(destDir, {recursive: true});
            copyFileSync(src, path.join(destDir, 'video.mp4'));
          } catch (e) {
            send({type: 'error', message: `Render saved but archiving failed: ${(e as Error).message}`});
            finish();
            return;
          }
          send({type: 'done', id, output: `/api/projects/${id}/video`});
        } else {
          send({type: 'error', message: `Render exited with code ${code}`});
        }
        finish();
      });
```

- [ ] **Step 4: Typecheck**

Run: `cd preview && npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add preview/app/api/generate/route.ts preview/app/api/render/route.ts
git commit -m "feat(api): generate emits project id; render targets a project by id"
```

---

## Task 9: Frontend — drop the dead root-spec copy from `copy-assets`

**Files:**
- Modify: `preview/scripts/copy-assets.mjs`

- [ ] **Step 1: Remove the spec-copy block**

Delete the block that copies the root `spec.json` into `preview/public/spec.json` (the `override`/`specCandidates`/`copyFileSync(srcSpec, dstSpec)` section). Keep the assets-mirror block. The Player no longer reads `preview/public/spec.json`.

- [ ] **Step 2: Verify copy-assets still runs**

Run: `cd preview && npm run copy-assets`
Expected: `[copy-assets] assets -> ...` with no spec warning/copy line and no error.

- [ ] **Step 3: Commit**

```bash
git add preview/scripts/copy-assets.mjs
git commit -m "chore(copy-assets): drop unused root spec.json copy"
```

---

## Task 10: Frontend — Studio + project list + render-by-id (UI)

**Files:**
- Modify: `preview/components/Studio.tsx`
- Rewrite: `preview/components/HistoryList.tsx`
- Modify: `preview/components/RenderControls.tsx`

UI integration verified live (Task 11). Keep types consistent with `preview/lib/projects.ts`.

- [ ] **Step 1: Rewrite the list component as a project list**

Replace `preview/components/HistoryList.tsx` entirely:

```tsx
'use client';

import {Eyebrow} from './ui';
import type {ProjectMeta} from '@/lib/projects';

function fmtDuration(frames: number, fps: number): string {
  return `${(frames / fps).toFixed(1)}s`;
}

function fmtAgo(at: number): string {
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

export function ProjectList({
  projects,
  selectedId,
  onOpen,
  onDelete,
}: {
  projects: ProjectMeta[];
  selectedId: string | null;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="glass rounded-xl p-5">
      <Eyebrow>Library</Eyebrow>
      {projects.length === 0 ? (
        <p className="mt-3 font-ui text-[13px] text-ink-muted">
          No videos yet — generate one to get started.
        </p>
      ) : (
        <div className="mt-3 flex flex-col">
          {projects.map((p) => (
            <div
              key={p.id}
              className={`flex items-center justify-between gap-3 rounded-[var(--radius-md)] px-3 py-2.5 transition-colors duration-150 hover:bg-white/[0.04] ${
                p.id === selectedId ? 'bg-white/[0.06]' : ''
              }`}
            >
              <button onClick={() => onOpen(p.id)} className="min-w-0 text-left">
                <div className="truncate font-ui text-[13.5px] font-medium text-ink">{p.title}</div>
                <div className="font-mono text-[11px] tabular-nums text-ink-muted">
                  {fmtDuration(p.durationInFrames, p.fps)} · {fmtAgo(p.createdAt)}
                  {p.hasRender ? ' · rendered' : ''}
                </div>
              </button>
              <div className="flex shrink-0 items-center gap-3">
                {p.hasRender && (
                  <a
                    href={`/api/projects/${p.id}/video`}
                    download="video.mp4"
                    className="font-ui text-[12px] text-accent-3 transition-opacity hover:opacity-80"
                  >
                    ↓ MP4
                  </a>
                )}
                <button
                  onClick={() => onDelete(p.id)}
                  className="font-ui text-[12px] text-ink-muted transition-colors hover:text-ink"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Point RenderControls at the selected project id**

In `preview/components/RenderControls.tsx`: delete the `RenderRecord` type and the `onComplete` prop; add `projectId` and an `onRendered` callback. Change the component signature and the fetch:

```tsx
export function RenderControls({
  spec,
  projectId,
  onRendered,
}: {
  spec: Spec;
  projectId: string;
  onRendered: () => void;
}) {
  // ...existing state unchanged...

  async function render() {
    // ...existing setup unchanged...
    const res = await fetch('/api/render', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({id: projectId}),
    });
    // ...existing stream reading unchanged...
  }
```

In the `done` branch of the render stream, replace the `onComplete({...RenderRecord})` call with `onRendered();` and keep using `msg.output` for the inline preview URL.

- [ ] **Step 3: Make Studio server-backed**

In `preview/components/Studio.tsx`, replace the history/spec state and effects. New imports:

```tsx
import {ProjectList} from './HistoryList';
import type {ProjectMeta} from '@/lib/projects';
```

Replace the `spec`/`history` state with:

```tsx
  const [spec, setSpec] = useState<Spec | null>(null);
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stages, setStages] = useState<Stage[]>(freshStages);
  const [generating, setGenerating] = useState(false);
  const [genNonce, setGenNonce] = useState(0);
```

Add list-loading + selection helpers and replace the mount effect:

```tsx
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
    setGenNonce((n) => n + 1);
  }

  async function deleteProject(id: string) {
    await fetch(`/api/projects/${id}`, {method: 'DELETE'});
    const list = await refreshProjects();
    if (id === selectedId) {
      if (list[0]) await openProject(list[0].id);
      else {
        setSpec(null);
        setSelectedId(null);
      }
    }
  }

  useEffect(() => {
    refreshProjects().then((list) => {
      if (list[0]) openProject(list[0].id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

In `generate(...)`, replace the `done` handler body so it selects the new project:

```tsx
          } else if (msg.type === 'done') {
            finished = true;
            const id = msg.id as string | null;
            const list = await refreshProjects();
            if (id) await openProject(id);
            const title = list.find((p) => p.id === id)?.title ?? 'Untitled';
            toast.success('Video generated', {id: toastId, description: title});
          } else if (msg.type === 'error') {
```

Update the render + list JSX (replace the `RenderControls` and `HistoryList` blocks):

```tsx
          {spec && selectedId && (
            <motion.div {...rise} transition={{...rise.transition, delay: 0.12}}>
              <RenderControls
                spec={spec}
                projectId={selectedId}
                onRendered={refreshProjects}
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
```

Replace the Player area's `failed` empty branch with an explicit empty-library state:

```tsx
              {spec ? (
                <PlayerClient key={genNonce} spec={spec} />
              ) : (
                <div className="flex aspect-[1080/1920] items-center justify-center p-6 text-center font-ui text-[13px] text-ink-muted">
                  No videos yet — generate one to get started.
                </div>
              )}
```

> Remove the now-unused `failed` state and its `/spec.json` fetch entirely.

- [ ] **Step 4: Typecheck**

Run: `cd preview && npm run typecheck`
Expected: no errors. (Fix any lingering references to `RenderRecord` / `HistoryList` / `failed`.)

- [ ] **Step 5: Commit**

```bash
git add preview/components/Studio.tsx preview/components/HistoryList.tsx preview/components/RenderControls.tsx
git commit -m "feat(ui): server-backed project library — open, render, download, delete"
```

---

## Task 11: End-to-end visual gate (eyes-on before merge)

**Files:** none (verification only).

Per the project's working rhythm, the written checks above are not enough — confirm on real frames before merging.

- [ ] **Step 1: Start the dev server**

Run: `cd preview && PORT=3100 npm run dev` (background it; the predev step runs build-registry + copy-assets).

- [ ] **Step 2: Generate two distinct videos**

In the browser at `localhost:3100`: generate topic A, wait for completion; generate topic B. Confirm both appear in the Library, newest first, B selected and previewing.

- [ ] **Step 3: Render the selected project**

Click Render; wait for completion. Confirm the row shows "rendered" and the ↓ MP4 link downloads a playable file from `/api/projects/<id>/video`.

- [ ] **Step 4: The persistence proof**

Hard-refresh the page. Confirm: both projects still listed, the previously selected one re-previews **pixel-perfect** (same hero frame), and the rendered MP4 still downloads. Navigate to `/templates` and back — list still present.

- [ ] **Step 5: Re-render an old project**

Open project A (older), click Render, confirm it produces A's MP4 (not B's) — verify by playing the downloaded file.

- [ ] **Step 6: Delete**

Delete project A. Confirm it disappears, B remains selected/previewing, and `projects/<A-id>/` + `remotion/public/assets/voiceover_<A-id>.wav` are gone on disk (`ls projects/`).

- [ ] **Step 7: Paste hero frames + finish the branch**

Capture the re-preview hero frame after refresh and the rendered-MP4 first frame. Once they read correctly, use the `superpowers:finishing-a-development-branch` skill to open the PR (never merge to master directly).

---

## Self-Review notes (author)

- **Spec coverage:** id minting (T1), namespaced voiceover (T2/T3), per-project snapshot + stop root spec (T3), directory-scan list (T5), get/delete (T6), video stream (T7), generate-emits-id + render-by-id + archive (T8), Option-2 root-spec removal (T9 + Studio in T10), re-render (T8 staging + T10 open-then-render + T11 S5), empty state (T10), manual delete (T6 + T10), pixel-perfect re-preview (T2/T3 namespacing + T11 S4) — all mapped.
- **Deferred (not in any task, by design):** footage GC, "keep last N" retention, incremental copy-assets mirror.
- **Confirmed:** `next@15.5.19` → App Router `params` is a Promise (`await params` throughout T6/T7).
