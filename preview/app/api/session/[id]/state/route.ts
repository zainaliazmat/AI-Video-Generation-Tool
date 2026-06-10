import {spawnJson} from '../../../_spawn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, {params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  try {
    const {code, json} = await spawnJson('session_state.py', ['--sid', id]);
    if (code !== 0 || json?.ok === false) {
      return Response.json({error: json?.error ?? 'session not found'}, {status: 404});
    }
    return Response.json(json);
  } catch (e) {
    return Response.json({error: e instanceof Error ? e.message : 'state failed'}, {status: 500});
  }
}
