/**
 * /api/templates/[id]
 *
 * GET  → {total, files} — pre-uninstall reference count for the drawer's
 *         danger zone (shown BEFORE the user confirms uninstall).
 * DELETE → {removed: true, referencedBy} on success;
 *           {error, stage} with HTTP 400 on failure (core-protected or unknown id).
 */

import {
  uninstall,
  scanReferences,
  InstallError,
} from '@installer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  {params}: {params: Promise<{id: string}>},
): Promise<Response> {
  const {id} = await params;
  try {
    const refs = scanReferences(id);
    return Response.json(refs);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({error: msg}, {status: 500});
  }
}

export async function DELETE(
  _req: Request,
  {params}: {params: Promise<{id: string}>},
): Promise<Response> {
  const {id} = await params;
  try {
    const result = await uninstall(id);
    return Response.json({removed: result.removed, referencedBy: result.referencedBy});
  } catch (e) {
    if (e instanceof InstallError) {
      return Response.json({error: e.message, stage: e.stage}, {status: 400});
    }
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({error: msg, stage: 'uninstall'}, {status: 400});
  }
}
