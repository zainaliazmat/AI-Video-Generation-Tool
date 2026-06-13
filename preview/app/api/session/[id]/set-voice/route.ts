import {spawnJson} from '../../../_spawn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Studio v3 M6-T9: §4.1 voice reopen. Defers a voice/speed change at an APPROVED
// voice gate via session_gate.py --op set_voice (gatekeeper.set_voice reopens the
// gate + marks the voice stage stale). The amber Re-approve then pays once.
export async function POST(req: Request, {params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  let body: {voice?: unknown; speed?: unknown};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const voice = typeof body?.voice === 'string' ? body.voice.trim() : '';
  const speed = typeof body?.speed === 'number' ? body.speed : 1.0;
  if (!voice) return Response.json({error: 'voice is required'}, {status: 400});

  try {
    const {code, json} = await spawnJson('session_gate.py', [
      '--op', 'set_voice', '--sid', id, '--voice', voice, '--speed', String(speed),
    ]);
    if (code !== 0 || json?.ok === false) {
      return Response.json({error: json?.error ?? 'set_voice failed'}, {status: 400});
    }
    return Response.json(json);
  } catch (e) {
    return Response.json({error: e instanceof Error ? e.message : 'set_voice failed'}, {status: 500});
  }
}
