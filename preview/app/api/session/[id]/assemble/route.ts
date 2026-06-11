import {spawn} from 'node:child_process';
import {spawnJson} from '../../../_spawn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Studio v2 Assemble gate (PRD §6.5) — chat-to-spec-patch. GET reads the theme/scene
// summary; POST either proposes a patch from a chat message (op:chat) or applies a
// confirmed patch (op:apply) via session_assemble.py.
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
    const {code, json} = await spawnJson('session_assemble.py', ['--sid', id, '--op', 'read']);
    if (code !== 0 || json?.ok === false) return Response.json({error: json?.error ?? 'read failed'}, {status: 400});
    return Response.json(json);
  } catch (e) {
    return Response.json({error: e instanceof Error ? e.message : 'read failed'}, {status: 500});
  }
}

export async function POST(req: Request, {params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  // Claim the single-flight slot before the first await (TOCTOU); cleared in finally.
  if (busy) return Response.json({error: 'an assemble op is already in progress'}, {status: 409});
  busy = true;
  try {
    let body: any;
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    let args: string[];
    let apply = false;
    if (body?.op === 'chat') {
      if (typeof body.message !== 'string' || !body.message.trim()) {
        return Response.json({error: 'chat needs a message'}, {status: 400});
      }
      args = ['--sid', id, '--op', 'chat', '--message', body.message];
    } else if (body?.op === 'apply') {
      if (!Array.isArray(body.patch)) return Response.json({error: 'apply needs patch[]'}, {status: 400});
      apply = true;
      args = ['--sid', id, '--op', 'apply', '--patch-json', JSON.stringify(body.patch)];
    } else {
      return Response.json({error: 'op must be chat|apply'}, {status: 400});
    }

    const {code, json} = await spawnJson('session_assemble.py', args, 120_000);
    if (code !== 0 || json?.ok === false) return Response.json({error: json?.error ?? 'assemble op failed'}, {status: 400});
    if (apply) await copyAssets(); // spec.json changed -> mirror it for the player
    return Response.json(json);
  } catch (e) {
    return Response.json({error: e instanceof Error ? e.message : 'assemble op failed'}, {status: 500});
  } finally {
    busy = false;
  }
}
