import {spawnJson} from '../../../../_spawn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Studio v2 Footage gate (PRD §6.4, lever ①) — propose a filmable query for a beat
// (LLM proposal passed through the frozen harden() rule). Read-only suggestion; the
// operator then runs re_query via /api/session/[id]/edit to rebind a clip.
export async function POST(req: Request, {params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  let body: any;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  if (typeof body?.scene !== 'number') {
    return Response.json({error: 'expected {scene:number}'}, {status: 400});
  }
  try {
    const {code, json} = await spawnJson(
      'session_footage.py',
      ['--sid', id, '--op', 'suggest', '--scene', String(body.scene)],
      120_000,
    );
    if (code !== 0 || json?.ok === false) return Response.json({error: json?.error ?? 'suggest failed'}, {status: 400});
    return Response.json(json); // {ok, scene, query, raw}
  } catch (e) {
    return Response.json({error: e instanceof Error ? e.message : 'suggest failed'}, {status: 500});
  }
}
