import {spawnJson} from '../../../_spawn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/session/[id]/set-auto-run
 * Body: { flag: boolean }
 * Spawns: session_gate.py --op set_auto_run --sid <id> --flag true|false
 * Returns the JSON result from the CLI (expects {ok:true}).
 */
export async function POST(req: Request, {params}: {params: Promise<{id: string}>}) {
  const {id: sid} = await params;

  let flag: boolean | undefined;
  try {
    const body = await req.json();
    if (typeof body?.flag === 'boolean') flag = body.flag;
  } catch {
    // fall through
  }
  if (flag === undefined) {
    return Response.json({error: 'A boolean "flag" field is required.'}, {status: 400});
  }

  try {
    const {code, json} = await spawnJson('session_gate.py', [
      '--op', 'set_auto_run',
      '--sid', sid,
      '--flag', flag ? 'true' : 'false',
    ]);
    if (code !== 0 || json?.ok === false) {
      return Response.json({error: json?.error ?? 'set_auto_run failed'}, {status: 500});
    }
    return Response.json(json);
  } catch (e) {
    return Response.json({error: e instanceof Error ? e.message : 'set_auto_run failed'}, {status: 500});
  }
}
