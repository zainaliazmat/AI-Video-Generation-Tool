import {spawn} from 'node:child_process';
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

export async function POST(req: Request, {params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  let body: any;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  if (body?.op !== 'pick' || typeof body.scene !== 'number' || typeof body.rank !== 'number') {
    return Response.json({error: 'expected {op:"pick", scene:number, rank:number}'}, {status: 400});
  }
  if (editing) {
    return Response.json({error: 'an edit is already in progress'}, {status: 409});
  }
  editing = true;
  try {
    const {code, json} = await spawnJson('session_edit.py', [
      '--sid', id, '--op', 'pick', '--scene', String(body.scene), '--rank', String(body.rank),
    ]);
    if (code !== 0 || json?.ok === false) {
      return Response.json({error: json?.error ?? 'edit failed'}, {status: 400});
    }
    await copyAssets(); // mirror any newly-referenced asset into preview/public
    return Response.json(json); // {ok, sid, scene, selectedRank, provenance}
  } catch (e) {
    return Response.json({error: e instanceof Error ? e.message : 'edit failed'}, {status: 500});
  } finally {
    editing = false;
  }
}
