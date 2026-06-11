import {spawn} from 'node:child_process';
import {spawnJson} from '../../../_spawn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Studio v2 Timing (PRD §6.3) — deterministic; the one escape hatch is fix-a-word.
// GET reads transcript tokens + line spans; POST fixes one caption token (text only).
let busy = false;

const copyAssets = () =>
  new Promise<void>((resolve) => {
    const cp = spawn('npm', ['run', 'copy-assets'], {cwd: process.cwd(), env: process.env, shell: false});
    cp.on('error', () => resolve());
    cp.on('close', () => resolve());
  });

export async function GET(_req: Request, {params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  try {
    const {code, json} = await spawnJson('session_timing.py', ['--sid', id, '--op', 'read']);
    if (code !== 0 || json?.ok === false) return Response.json({error: json?.error ?? 'read failed'}, {status: 400});
    return Response.json(json);
  } catch (e) {
    return Response.json({error: e instanceof Error ? e.message : 'read failed'}, {status: 500});
  }
}

export async function POST(req: Request, {params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  // Claim the single-flight slot before the first await (TOCTOU); cleared in finally.
  if (busy) return Response.json({error: 'a timing edit is already in progress'}, {status: 409});
  busy = true;
  try {
    let body: any;
    try {
      body = await req.json();
    } catch {
      body = {};
    }
    if (body?.op !== 'fix_word' || typeof body.index !== 'number' || typeof body.text !== 'string') {
      return Response.json({error: 'expected {op:"fix_word", index:number, text:string}'}, {status: 400});
    }

    const {code, json} = await spawnJson(
      'session_timing.py',
      ['--sid', id, '--op', 'fix_word', '--index', String(body.index), '--text', body.text],
      120_000,
    );
    if (code !== 0 || json?.ok === false) return Response.json({error: json?.error ?? 'fix failed'}, {status: 400});
    await copyAssets(); // captions rebuilt in spec.json -> mirror it
    return Response.json(json);
  } catch (e) {
    return Response.json({error: e instanceof Error ? e.message : 'fix failed'}, {status: 500});
  } finally {
    busy = false;
  }
}
