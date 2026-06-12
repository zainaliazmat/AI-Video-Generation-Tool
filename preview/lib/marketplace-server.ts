/**
 * Server-only helpers: build the UnifiedItem arrays + installedIds set for the
 * template gallery page (§16.2/§16.6).
 *
 * These functions read from disk and must only be called in a server context
 * (RSC, Route Handler, or similar). They are IO-full by design; the pure
 * derive/filter logic lives in marketplace-ui.ts.
 */

import {existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type {TemplateMeta} from './templates';
import type {UnifiedItem} from './marketplace-ui';

// ---------------------------------------------------------------------------
// Marketplace catalog index
// ---------------------------------------------------------------------------

export interface CatalogPackage {
  id: string;
  name: string;
  version: string;
  kind: string;
  apiVersion: string;
  author: string;
  license?: string;
  description?: string;
  tags?: string[];
  package: string;
  sha256: string;
  preview?: {poster?: string};
}

export interface MarketplaceIndex {
  catalogVersion: number;
  packages: CatalogPackage[];
  error?: string;
}

/**
 * Read marketplace/index.json relative to the preview app's cwd (preview/).
 * Returns empty catalog on missing file; `error:'corrupt'` on parse failure.
 */
export function loadMarketplaceIndex(): MarketplaceIndex {
  const indexPath = resolve(process.cwd(), '..', 'marketplace', 'index.json');
  if (!existsSync(indexPath)) {
    return {catalogVersion: 1, packages: []};
  }
  try {
    return JSON.parse(readFileSync(indexPath, 'utf8')) as MarketplaceIndex;
  } catch {
    console.warn('[marketplace-server] Failed to parse marketplace/index.json — returning empty catalog');
    return {catalogVersion: 1, packages: [], error: 'corrupt'};
  }
}

// ---------------------------------------------------------------------------
// Map installed TemplateMeta[] → UnifiedItem[]
// ---------------------------------------------------------------------------

/**
 * Convert installed template metas (read from manifests) into UnifiedItems.
 * source = 'installed', installed = true (they're on disk; installed-ness
 * is also encoded in installedIds for cross-tab derivation).
 */
export function installedMetaToUnifiedItems(metas: TemplateMeta[]): UnifiedItem[] {
  return metas.map((m) => ({
    id: m.id,
    name: m.name,
    kind: m.kind,
    author: m.author,
    version: m.version,
    description: m.description,
    tags: m.tags,
    license: m.license,
    source: 'installed' as const,
    installed: true,
    uncommitted: m.uncommitted,
    mp4: m.mp4,
    poster: m.poster,
    durationFrames: m.durationFrames,
  }));
}

// ---------------------------------------------------------------------------
// Map catalog packages → UnifiedItem[]
// ---------------------------------------------------------------------------

/**
 * Convert catalog packages from marketplace/index.json into UnifiedItems.
 * `installed` is intentionally false here; the page derives installed-ness
 * from the installedIds set in deriveView (§16.6). catalogVersion is set from
 * the package's version field so the update triad can compare it.
 *
 * Poster: served via /api/marketplace/poster?id=<id> so Next.js can resolve
 * the file from outside the public/ directory. null when the package has no
 * poster declared. The card falls back to a kind-tone gradient placeholder
 * when null (or on img onError).
 */
export function catalogPackagesToUnifiedItems(packages: CatalogPackage[]): UnifiedItem[] {
  return packages.map((pkg) => ({
    id: pkg.id,
    name: pkg.name,
    kind: pkg.kind,
    author: pkg.author,
    version: pkg.version,
    description: pkg.description,
    tags: pkg.tags,
    license: pkg.license,
    source: 'catalog' as const,
    installed: false, // will be derived from installedIds in deriveView (§16.6)
    catalogVersion: pkg.version,
    poster: pkg.preview?.poster ? `/api/marketplace/poster?id=${encodeURIComponent(pkg.id)}` : null,
    mp4: null,
  }));
}

// ---------------------------------------------------------------------------
// Build the full server payload for page.tsx
// ---------------------------------------------------------------------------

export interface GalleryServerPayload {
  installed: UnifiedItem[];
  catalog: UnifiedItem[];
  installedIds: string[];
}

/**
 * Assemble the server payload from installed manifests + marketplace index.
 * Called once per page request (force-dynamic).
 */
export function buildGalleryPayload(installedMetas: TemplateMeta[]): GalleryServerPayload {
  const catalogIndex = loadMarketplaceIndex();
  const installed = installedMetaToUnifiedItems(installedMetas);
  const catalog = catalogPackagesToUnifiedItems(catalogIndex.packages);
  const installedIds = installedMetas.map((m) => m.id);
  return {installed, catalog, installedIds};
}
