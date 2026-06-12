/**
 * GET /api/templates/state
 *
 * Returns the full installer state surface:
 *   {installedIds, templates, lastError}
 *
 * The UI calls this to re-sync after a client disconnect (§16.15-1), on
 * terminal SSE events, and on page load. installedIds drives all installed-ness
 * derivation — never assert locally, always derive from this (§16.6).
 */

import {installedState} from '@installer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    return Response.json(installedState());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({error: msg}, {status: 500});
  }
}
