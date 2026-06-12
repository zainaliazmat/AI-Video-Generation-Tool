/**
 * GET /api/marketplace/index
 *
 * Returns the local marketplace catalog index.
 *
 * On success: {catalogVersion, packages: CatalogEntry[]}
 * On missing index: {catalogVersion:1, packages:[]} (LocalFolderSource already
 *   returns this shape when the file is absent).
 * On corrupt/parse-error: {catalogVersion:1, packages:[], error:'corrupt'} so
 *   the page can surface the §16.5 "index corrupt" state (packages empty + error
 *   present) without a hard failure.
 */

import {defaultMarketplaceSource} from '@/lib/marketplace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const src = defaultMarketplaceSource();
  try {
    const index = await src.getIndex();
    return Response.json(index);
  } catch (e) {
    // Parse error or unexpected I/O failure — return an empty catalog with an
    // error marker so the UI can distinguish "no packages" from "corrupt index".
    console.warn('[marketplace/index] failed to read catalog:', e instanceof Error ? e.message : e);
    return Response.json({catalogVersion: 1, packages: [], error: 'corrupt'});
  }
}
