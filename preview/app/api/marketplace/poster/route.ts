/**
 * GET /api/marketplace/poster?id=<id>
 *
 * Serves the catalog poster image for a given package id.
 *
 * Reads marketplace/index.json to find the package version + poster path,
 * then streams the jpg bytes with content-type image/jpeg.
 *
 * Safety: the resolved poster path is checked to be under the marketplace
 * directory (containment guard). Returns 404 on missing package, missing
 * file, or path-escape attempt.
 */

import {readFileSync, existsSync} from 'node:fs';
import {resolve, sep} from 'node:path';
import type {NextRequest} from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CatalogPackage {
  id: string;
  version: string;
  preview?: {poster?: string};
}

interface MarketplaceIndex {
  packages: CatalogPackage[];
}

export async function GET(request: NextRequest): Promise<Response> {
  const id = request.nextUrl.searchParams.get('id');
  if (!id || !id.trim()) {
    return new Response('Missing ?id param', {status: 400});
  }

  // Resolve paths relative to the preview app cwd (preview/)
  // The marketplace directory lives at ../marketplace from preview/
  const marketplaceDir = resolve(process.cwd(), '..', 'marketplace');
  const indexPath = resolve(marketplaceDir, 'index.json');

  if (!existsSync(indexPath)) {
    return new Response('Marketplace index not found', {status: 404});
  }

  let index: MarketplaceIndex;
  try {
    index = JSON.parse(readFileSync(indexPath, 'utf8')) as MarketplaceIndex;
  } catch {
    return new Response('Marketplace index corrupt', {status: 500});
  }

  const pkg = index.packages.find((p) => p.id === id);
  if (!pkg) {
    return new Response(`Package not found: ${id}`, {status: 404});
  }

  const posterRelative = pkg.preview?.poster;
  if (!posterRelative) {
    return new Response('No poster for package', {status: 404});
  }

  // Resolve and guard against path traversal
  const posterPath = resolve(marketplaceDir, posterRelative);
  if (!posterPath.startsWith(marketplaceDir + sep) && posterPath !== marketplaceDir) {
    return new Response('Forbidden', {status: 403});
  }

  if (!existsSync(posterPath)) {
    return new Response('Poster file not found', {status: 404});
  }

  const buf = readFileSync(posterPath);
  return new Response(buf, {
    status: 200,
    headers: {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
    },
  });
}
