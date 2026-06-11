import {spawnJson} from '../../../_spawn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Studio v2 Script gate (PRD §6.1). GET reads beats + verify state; POST applies a
// gate op (edit_beat / drop_beat / regenerate / approve) via session_script.py.
let busy = false;

export async function GET(_req: Request, {params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  try {
    const {code, json} = await spawnJson('session_script.py', ['--sid', id, '--op', 'read']);
    if (code !== 0 || json?.ok === false) {
      return Response.json({error: json?.error ?? 'read failed'}, {status: 400});
    }
    return Response.json(json);
  } catch (e) {
    return Response.json({error: e instanceof Error ? e.message : 'read failed'}, {status: 500});
  }
}

export async function POST(req: Request, {params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  // Claim the single-flight slot BEFORE the first await, else two requests can both
  // pass the guard before either sets the flag (TOCTOU). Cleared in finally.
  if (busy) return Response.json({error: 'a script edit is already in progress'}, {status: 409});
  busy = true;
  try {
    let body: any;
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const op: string = body?.op;
    const args: string[] = ['--sid', id];
    if (op === 'edit_beat') {
      if (typeof body.index !== 'number') return Response.json({error: 'edit_beat needs index'}, {status: 400});
      args.push('--op', 'edit_beat', '--index', String(body.index));
      if (typeof body.text === 'string') args.push('--text', body.text);
      if (body.clearData) args.push('--clear-data');
      else if (body.data !== undefined) args.push('--data-json', JSON.stringify(body.data));
    } else if (op === 'drop_beat') {
      if (typeof body.index !== 'number') return Response.json({error: 'drop_beat needs index'}, {status: 400});
      args.push('--op', 'drop_beat', '--index', String(body.index));
    } else if (op === 'regenerate') {
      args.push('--op', 'regenerate', '--feedback', String(body.feedback ?? ''));
    } else if (op === 'approve') {
      args.push('--op', 'approve');
      if (Array.isArray(body.edits)) args.push('--edits-json', JSON.stringify(body.edits));
      if (Array.isArray(body.guidance)) args.push('--guidance-json', JSON.stringify(body.guidance));
    } else if (op === 'style_memory_read') {
      // F-6 manager — read is routed through POST so it shares the single-flight
      // guard with pin/delete (they mutate the same file).
      args.push('--op', 'style_memory_read');
    } else if (op === 'style_memory_pin' || op === 'style_memory_delete') {
      if ((body.kind !== 'example' && body.kind !== 'guidance') || typeof body.index !== 'number') {
        return Response.json({error: `${op} needs kind:'example'|'guidance' and index:number`}, {status: 400});
      }
      args.push('--op', op, '--kind', body.kind, '--index', String(body.index));
      if (op === 'style_memory_pin') args.push('--value', body.value === false ? 'false' : 'true');
    } else {
      return Response.json({error: 'op must be edit_beat|drop_beat|regenerate|approve|style_memory_*'}, {status: 400});
    }

    // edit_beat / regenerate re-run downstream (TTS, whisper, footage) — allow time.
    const {code, json} = await spawnJson('session_script.py', args, 300_000);
    if (code !== 0 || json?.ok === false) {
      return Response.json({error: json?.error ?? 'script op failed'}, {status: 400});
    }
    return Response.json(json);
  } catch (e) {
    return Response.json({error: e instanceof Error ? e.message : 'script op failed'}, {status: 500});
  } finally {
    busy = false;
  }
}
