import {spawnJson} from '../../../_spawn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/session/[id]/preview-reopen
 * Body: { gate: string }
 * Spawns: session_gate.py --op preview_reopen --sid <id> --gate <gate>
 * Returns the JSON result: { gate, reruns, staleGates, ...M5 pin detail if present }
 */
export async function POST(req: Request, {params}: {params: Promise<{id: string}>}) {
  const {id: sid} = await params;

  let gate = '';
  try {
    const body = await req.json();
    gate = typeof body?.gate === 'string' ? body.gate.trim() : '';
  } catch {
    // fall through
  }
  if (!gate) {
    return Response.json({error: 'A non-empty "gate" field is required.'}, {status: 400});
  }

  try {
    const {code, json} = await spawnJson('session_gate.py', [
      '--op', 'preview_reopen',
      '--sid', sid,
      '--gate', gate,
    ]);
    if (code !== 0 || json?.ok === false) {
      return Response.json({error: json?.error ?? 'preview_reopen failed'}, {status: 500});
    }
    return Response.json(json);
  } catch (e) {
    return Response.json({error: e instanceof Error ? e.message : 'preview_reopen failed'}, {status: 500});
  }
}
