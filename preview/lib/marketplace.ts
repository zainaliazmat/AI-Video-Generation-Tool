import {readFileSync, existsSync} from 'node:fs';
import {resolve, join, sep} from 'node:path';
import {createHash} from 'node:crypto';

export interface CatalogEntry {
  id: string; name: string; version: string; kind: string; apiVersion: string;
  author: string; license?: string; description?: string; tags?: string[];
  package: string; sha256: string; preview?: {poster?: string};
}
export interface CatalogIndex { catalogVersion: number; packages: CatalogEntry[]; }

export interface MarketplaceSource {
  getIndex(): Promise<CatalogIndex>;
  fetchPackage(entry: CatalogEntry): Promise<{zipPath: string}>; // sha256-verified
}

/** v1 source: reads the committed marketplace/ store from disk. The future
 *  remote is HttpSource — same index JSON, same zips, same hash check (§7.2). */
export class LocalFolderSource implements MarketplaceSource {
  constructor(private marketplaceDir: string) {}
  async getIndex(): Promise<CatalogIndex> {
    const p = join(this.marketplaceDir, 'index.json');
    if (!existsSync(p)) return {catalogVersion: 1, packages: []};
    return JSON.parse(readFileSync(p, 'utf8'));
  }
  async fetchPackage(entry: CatalogEntry): Promise<{zipPath: string}> {
    const zipPath = resolve(this.marketplaceDir, entry.package);
    if (!zipPath.startsWith(resolve(this.marketplaceDir) + sep)) {
      throw new Error(`marketplace entry "${entry.id}" resolves outside the store: ${entry.package}`);
    }
    if (!existsSync(zipPath)) {
      throw new Error(`marketplace package missing: ${entry.package} — run build-marketplace-index`);
    }
    const actual = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
    if (actual !== entry.sha256) {
      throw new Error(`sha256 mismatch for ${entry.id}: catalog ${entry.sha256}, file ${actual}`);
    }
    return {zipPath};
  }
}

/** Default source rooted at the repo's marketplace/ dir (server cwd = preview/). */
export function defaultMarketplaceSource(): LocalFolderSource {
  return new LocalFolderSource(resolve(process.cwd(), '..', 'marketplace'));
}
