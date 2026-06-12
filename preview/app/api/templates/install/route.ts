/**
 * POST /api/templates/install
 *
 * Accepts two content shapes:
 *   - multipart/form-data  { file: File (.zip), update?: 'true', confirmReplace?: 'true' }
 *   - application/json     { catalogId: string, update?: boolean, confirmReplace?: boolean }
 *
 * Returns an SSE stream of SSEEvent objects (text/event-stream).
 * Stage events stream as the install pipeline progresses; terminal event is
 * {type:'done'} or {type:'error'}.
 *
 * Lock-conflict (InstallError stage='lock', statusCode=409): the engine throws
 * immediately when a second install is attempted while one is running. This is
 * caught by runInstall and emitted as {type:'error', stage:'lock', message}.
 * We still return HTTP 200 with the SSE body so the UI reads it inline (§16.3)
 * rather than having to special-case a non-200 response.
 *
 * §16.15-1 keep-alive-on-disconnect: the cancel() handler on the ReadableStream
 * does NOT abort the install. install() runs to completion/rollback server-side
 * and the UI re-syncs via GET /api/templates/state. This is intentional and
 * matches the M4 spec contract — do NOT add abort logic here.
 */

import {writeFileSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {runInstall} from '@/lib/install-stream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const ct = req.headers.get('content-type') ?? '';
  const encoder = new TextEncoder();

  let input: Parameters<typeof runInstall>[0];
  let opts: Parameters<typeof runInstall>[1];
  let tempZipPath: string | null = null;

  // Parse request
  if (ct.includes('multipart/form-data')) {
    let formData: FormData;
    try {
      formData = await req.formData();
    } catch (e) {
      return Response.json({error: 'failed to parse multipart form'}, {status: 400});
    }
    const file = formData.get('file');
    if (!(file instanceof File)) {
      return Response.json({error: 'missing "file" field in multipart body'}, {status: 400});
    }
    if (!file.name.endsWith('.zip')) {
      return Response.json({error: 'file must be a .zip template package'}, {status: 400});
    }
    // Write to a temp path for the engine to read
    const tmpDir = tmpdir();
    tempZipPath = join(tmpDir, `tm-install-${randomUUID()}.zip`);
    const bytes = await file.arrayBuffer();
    writeFileSync(tempZipPath, Buffer.from(bytes));

    const update = formData.get('update') === 'true';
    const confirmReplace = formData.get('confirmReplace') === 'true';
    input = {kind: 'zip', zipPath: tempZipPath};
    opts = {update, confirmReplace};
  } else {
    // Treat everything else as application/json
    let body: {catalogId?: string; update?: boolean; confirmReplace?: boolean};
    try {
      body = await req.json();
    } catch (e) {
      return Response.json({error: 'invalid JSON body'}, {status: 400});
    }
    if (!body.catalogId || typeof body.catalogId !== 'string') {
      return Response.json({error: 'missing "catalogId" in JSON body'}, {status: 400});
    }
    input = {kind: 'catalog', catalogId: body.catalogId};
    opts = {update: body.update, confirmReplace: body.confirmReplace};
  }

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;

      const send = (payload: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          // Stream already closed (client disconnected) — stop sending.
          closed = true;
        }
      };

      const finish = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      try {
        for await (const event of runInstall(input, opts)) {
          send(event);
        }
      } catch (e) {
        // Unexpected error in the generator itself (not in the engine — those
        // are caught inside runInstall and emitted as {type:'error'} events).
        send({type: 'error', stage: 'install', message: e instanceof Error ? e.message : String(e)});
      } finally {
        // Clean up the temp zip regardless of outcome
        if (tempZipPath) {
          try {
            rmSync(tempZipPath, {force: true});
          } catch {
            /* best-effort */
          }
          tempZipPath = null;
        }
        finish();
      }
    },

    cancel() {
      // §16.15-1: client disconnect does NOT abort the install.
      // install() runs to completion/rollback server-side — it has no client
      // coupling. The UI re-syncs via GET /api/templates/state on reconnect.
      // Intentionally a no-op — do NOT call any abort/kill here.
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
