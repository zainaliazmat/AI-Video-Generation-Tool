// preview/app/api/projects/[id]/route.ts
import {readFileSync, existsSync} from 'node:fs';
import path from 'node:path';
import {isValidProjectId} from '@/lib/projects';
import {projectDir} from '@/lib/projects-server';
import {spawnJson} from '../../_spawn';

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
  // F-7: real server-side validation + the derived spec version for the rail pills.
  // Best-effort — a spawn failure degrades the pills to "unverified", never a 500.
  let meta: unknown = null;
  try {
    const {code, json} = await spawnJson('session_meta.py', ['--sid', id], 30_000);
    if (code === 0 && json?.ok) meta = json;
  } catch {
    /* pills render the unverified state */
  }
  return Response.json({spec, sources, meta});
}

export async function DELETE(_req: Request, {params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  if (!isValidProjectId(id)) return bad(400, 'Invalid project id');
  // All sqlite + filesystem teardown lives in Python (single owner of the DB).
  // spawnJson resolves {code, json} even on non-zero exit; it only rejects on a spawn
  // error / timeout / unparseable stdout — hence both the code check and the try/catch
  // (mirrors the session/[id]/state + edit routes).
  try {
    const {code, json} = await spawnJson('session_delete.py', ['--sid', id]);
    if (code !== 0 || json?.ok === false) return bad(500, json?.error ?? 'delete failed');
    return Response.json({ok: true});
  } catch (e) {
    return bad(500, e instanceof Error ? e.message : 'delete failed');
  }
}
