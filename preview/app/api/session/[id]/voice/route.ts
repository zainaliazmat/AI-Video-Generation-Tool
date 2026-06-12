import {spawn} from 'node:child_process';
import {spawnJson} from '../../../_spawn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Studio v2 Voice gate (PRD §6.2). GET lists voices + current; POST previews a voice
// (synthesize a sample line) or applies one (re-synth narration + re-time captions).
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
    const {code, json} = await spawnJson('session_voice.py', ['--op', 'list', '--sid', id]);
    if (code !== 0 || json?.ok === false) return Response.json({error: json?.error ?? 'list failed'}, {status: 400});
    return Response.json(json);
  } catch (e) {
    return Response.json({error: e instanceof Error ? e.message : 'list failed'}, {status: 500});
  }
}

export async function POST(req: Request, {params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  // Claim the single-flight slot before the first await (TOCTOU); cleared in finally.
  if (busy) return Response.json({error: 'a voice op is already in progress'}, {status: 409});
  busy = true;
  try {
    let body: any;
    try {
      body = await req.json();
    } catch {
      body = {};
    }
    const voice = String(body?.voice ?? '');
    const speed = typeof body?.speed === 'number' ? body.speed : 1.0;
    if (!voice) return Response.json({error: 'voice is required'}, {status: 400});

    const isApply = body?.op === 'apply';
    const args = isApply
      ? ['--op', 'apply', '--sid', id, '--voice', voice, '--speed', String(speed)]
      : ['--op', 'preview', '--sid', id, '--voice', voice, '--speed', String(speed)];

    // apply re-synthesizes the whole narration + re-times — allow time. preview is one line.
    const {code, json} = await spawnJson('session_voice.py', args, isApply ? 300_000 : 120_000);
    if (code !== 0 || json?.ok === false) return Response.json({error: json?.error ?? 'voice op failed'}, {status: 400});
    await copyAssets(); // mirror the new wav (preview sample / re-synthesized narration) into public
    return Response.json(json);
  } catch (e) {
    return Response.json({error: e instanceof Error ? e.message : 'voice op failed'}, {status: 500});
  } finally {
    busy = false;
  }
}
