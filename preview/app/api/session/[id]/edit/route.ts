import {spawn} from 'node:child_process';
import {writeFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnJson} from '../../../_spawn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Single-flight: one edit at a time (shared spec.json + assets, like /api/generate).
let editing = false;

const copyAssets = () =>
  new Promise<void>((resolve) => {
    const cp = spawn('npm', ['run', 'copy-assets'], {cwd: process.cwd(), env: process.env, shell: false});
    cp.on('error', () => resolve());
    cp.on('close', () => resolve());
  });

type ParsedEdit = {args?: string[]; cleanupDir?: string; error?: string};

// Translate the request into session_edit.py CLI args.
//   pick / re_query  → JSON body  {op, scene, rank|query}
//   upload           → multipart  {op:"upload", scene, file}  (staged to a temp path the op reads)
async function parseEdit(req: Request, id: string): Promise<ParsedEdit> {
  const ct = req.headers.get('content-type') || '';

  if (ct.includes('multipart/form-data')) {
    const form = await req.formData();
    const rawScene = form.get('scene'); // Number(null) === 0 — reject a missing field explicitly
    const scene = rawScene === null ? NaN : Number(rawScene);
    const file = form.get('file') as unknown as {arrayBuffer?: () => Promise<ArrayBuffer>; name?: string} | null;
    if (!Number.isInteger(scene) || !file || typeof file.arrayBuffer !== 'function') {
      return {error: 'expected multipart {scene:number, file:<file>}'};
    }
    // Stage the upload under a temp path; the Python op content-hashes + copies it into
    // the assets dir, so the temp can be removed once the edit returns.
    const dir = await mkdtemp(join(tmpdir(), 'a6-upload-'));
    const safeName = (file.name || 'upload').replace(/[^a-zA-Z0-9._-]/g, '_') || 'upload';
    const tmp = join(dir, safeName);
    await writeFile(tmp, Buffer.from(await file.arrayBuffer()));
    return {args: ['--sid', id, '--op', 'upload', '--scene', String(scene), '--file', tmp], cleanupDir: dir};
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  if (typeof body?.scene !== 'number') {
    return {error: 'expected scene:number'};
  }
  if (body.op === 'pick') {
    if (typeof body.rank !== 'number') return {error: 'pick requires rank:number'};
    return {args: ['--sid', id, '--op', 'pick', '--scene', String(body.scene), '--rank', String(body.rank)]};
  }
  if (body.op === 're_query') {
    const q = typeof body.query === 'string' ? body.query.trim() : '';
    if (!q) return {error: 're_query requires a non-empty query'};
    return {args: ['--sid', id, '--op', 're_query', '--scene', String(body.scene), '--query', q]};
  }
  return {error: 'expected {op:"pick"|"re_query"|"upload", scene, ...}'};
}

export async function POST(req: Request, {params}: {params: Promise<{id: string}>}) {
  const {id} = await params;

  if (editing) {
    return Response.json({error: 'an edit is already in progress'}, {status: 409});
  }

  let parsed: ParsedEdit;
  try {
    parsed = await parseEdit(req, id);
  } catch (e) {
    return Response.json({error: e instanceof Error ? e.message : 'bad request'}, {status: 400});
  }
  if (parsed.error || !parsed.args) {
    if (parsed.cleanupDir) await rm(parsed.cleanupDir, {recursive: true, force: true}).catch(() => {});
    return Response.json({error: parsed.error ?? 'bad request'}, {status: 400});
  }

  editing = true;
  try {
    // a first-time pick/re_query downloads a (multi-MB) clip — allow well beyond the 60s default
    const {code, json} = await spawnJson('session_edit.py', parsed.args, 180_000);
    if (code !== 0 || json?.ok === false) {
      return Response.json({error: json?.error ?? 'edit failed'}, {status: 400});
    }
    await copyAssets(); // mirror any newly-referenced asset into preview/public
    return Response.json(json); // {ok, sid, scene, selectedRank, provenance}
  } catch (e) {
    return Response.json({error: e instanceof Error ? e.message : 'edit failed'}, {status: 500});
  } finally {
    editing = false;
    if (parsed.cleanupDir) await rm(parsed.cleanupDir, {recursive: true, force: true}).catch(() => {});
  }
}
