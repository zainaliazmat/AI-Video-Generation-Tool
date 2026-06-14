import {spawnJson} from '../_spawn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/prefs
 * Spawns: script_prefs_cli.py --op get
 * Returns {ok, initialized, prefs} — the global channel-voice preferences doc.
 */
export async function GET() {
  try {
    const {code, json} = await spawnJson('script_prefs_cli.py', ['--op', 'get']);
    if (code !== 0 || json?.ok === false) {
      return Response.json({error: json?.error ?? 'prefs get failed'}, {status: 500});
    }
    return Response.json(json);
  } catch (e) {
    return Response.json({error: e instanceof Error ? e.message : 'prefs get failed'}, {status: 500});
  }
}

/**
 * POST /api/prefs
 * Body: the preferences object (set fields). Spawns:
 *   script_prefs_cli.py --op save --prefs-json '<json>'
 * The CLI normalizes/validates the shape before persisting.
 */
export async function POST(req: Request) {
  let prefs: unknown;
  try {
    prefs = await req.json();
  } catch {
    return Response.json({error: 'A JSON preferences object is required.'}, {status: 400});
  }
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) {
    return Response.json({error: 'A JSON preferences object is required.'}, {status: 400});
  }
  try {
    const {code, json} = await spawnJson('script_prefs_cli.py', [
      '--op', 'save',
      '--prefs-json', JSON.stringify(prefs),
    ]);
    if (code !== 0 || json?.ok === false) {
      return Response.json({error: json?.error ?? 'prefs save failed'}, {status: 500});
    }
    return Response.json(json);
  } catch (e) {
    return Response.json({error: e instanceof Error ? e.message : 'prefs save failed'}, {status: 500});
  }
}
