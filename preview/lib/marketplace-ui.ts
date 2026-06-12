/**
 * Pure derive/filter logic for the two-tab template marketplace UI.
 *
 * §16.6: installed-ness is DERIVED from the installedIds set, never asserted
 * per-component. This module is IO-free — no Node.js, no React, no Next.js.
 * Test it with vitest in node env.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Tab = 'installed' | 'marketplace';

export interface UnifiedItem {
  id: string;
  name: string;
  kind: string;
  author: string;
  version: string;
  description?: string;
  tags?: string[];
  license?: string;
  source: 'installed' | 'catalog';
  /** Derived from the installedIds set — never asserted locally (§16.6). */
  installed: boolean;
  /** Version available in the catalog (for the update triad, §16.4). */
  catalogVersion?: string;
  /** True when the template directory has uncommitted git changes (§16.11). */
  uncommitted?: boolean;
  /** True when installed AND catalogVersion > installed version. */
  updateAvailable?: boolean;
  mp4?: string | null;
  poster?: string | null;
  /** Frame duration range — present for installed items, absent for catalog. */
  durationFrames?: {min: number; max: number};
}

export interface DeriveInput {
  installed: UnifiedItem[];
  catalog: UnifiedItem[];
  installedIds: Set<string>;
  tab: Tab;
  query: string;
  kind: string | 'all';
}

export interface DeriveOutput {
  /** The active tab's items, filtered by query AND kind pill. */
  items: UnifiedItem[];
  /** Count of installed items matching the current query (NOT kind — §16.2). */
  installedCount: number;
  /** Count of catalog items matching the current query (NOT kind — §16.2). */
  marketplaceCount: number;
  /** Sorted unique kinds present in the active tab's query-filtered set
   *  (computed BEFORE the kind pill — pills must not vanish when one is selected). */
  kinds: string[];
  /** Zero-result state for §16.2 cross-tab link. */
  zeroResult: {active: boolean; otherTabMatches: number};
}

// ---------------------------------------------------------------------------
// Semver compare (strict x.y.z — mirrors the installer's semver rules)
// ---------------------------------------------------------------------------

/** Returns true if `a` > `b` (as x.y.z integers). */
function semverGt(a: string, b: string): boolean {
  const parse = (v: string): [number, number, number] => {
    const [major = 0, minor = 0, patch = 0] = v
      .replace(/^[^0-9]*/, '') // strip leading non-numeric (e.g. 'v')
      .split('.')
      .map(Number);
    return [major, minor, patch];
  };
  const [aMaj, aMin, aPatch] = parse(a);
  const [bMaj, bMin, bPatch] = parse(b);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPatch > bPatch;
}

// ---------------------------------------------------------------------------
// Query matching
// ---------------------------------------------------------------------------

/** Case-insensitive substring match against name, id, kind, author, tags. */
function matches(item: UnifiedItem, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const haystack = [item.name, item.id, item.kind, item.author, ...(item.tags ?? [])].join('\0').toLowerCase();
  return haystack.includes(q);
}

function matchesKind(item: UnifiedItem, kind: string): boolean {
  return kind === 'all' || item.kind === kind;
}

// ---------------------------------------------------------------------------
// deriveView — the pure selector
// ---------------------------------------------------------------------------

/**
 * Pure selector: given the full input state, derive everything the UI needs
 * to render the two-tab gallery without any IO.
 *
 * Key invariants (§16.2/§16.6):
 * - Tab counts (installedCount / marketplaceCount) are query-scoped ONLY.
 *   The kind pill facets the active grid but NEVER changes the tab counts.
 * - installed flag on each catalog item is derived from installedIds — never
 *   taken from the catalog item's own `installed` field (which may be stale).
 * - updateAvailable = installed && semver(catalogVersion) > installed version.
 * - kinds = unique kinds from the active tab's query-filtered set, computed
 *   BEFORE applying the kind pill (so pills stay visible when one is active).
 */
export function deriveView(input: DeriveInput): DeriveOutput {
  const {installed, catalog, installedIds, tab, query, kind} = input;

  // Build a fast lookup: id → installed version (for updateAvailable).
  const installedVersionById = new Map<string, string>(
    installed.map((item) => [item.id, item.version]),
  );

  // Annotate catalog items with derived `installed` + `updateAvailable`.
  const annotatedCatalog: UnifiedItem[] = catalog.map((item) => {
    const isInstalled = installedIds.has(item.id);
    let updateAvailable: boolean | undefined;
    if (isInstalled && item.catalogVersion) {
      const installedVer = installedVersionById.get(item.id);
      updateAvailable = installedVer !== undefined && semverGt(item.catalogVersion, installedVer);
    }
    return {...item, installed: isInstalled, updateAvailable};
  });

  // ------------------------------------------------------------------
  // Tab counts: query-scoped only (kind pill does NOT affect counts).
  // §16.2: "both tab labels update" when the user types a search query.
  // ------------------------------------------------------------------
  const installedCount = installed.filter((i) => matches(i, query)).length;
  const marketplaceCount = annotatedCatalog.filter((i) => matches(i, query)).length;

  // ------------------------------------------------------------------
  // Active tab source
  // ------------------------------------------------------------------
  const activeSource = tab === 'installed' ? installed : annotatedCatalog;

  // ------------------------------------------------------------------
  // Kinds facets: derived from the active tab's query-filtered set,
  // BEFORE applying the kind pill (so the full pill set stays visible).
  // ------------------------------------------------------------------
  const queryFiltered = activeSource.filter((i) => matches(i, query));
  const kindSet = new Set(queryFiltered.map((i) => i.kind));
  const kinds = [...kindSet].sort();

  // ------------------------------------------------------------------
  // Items: active tab filtered by BOTH query AND kind pill.
  // ------------------------------------------------------------------
  const items = queryFiltered.filter((i) => matchesKind(i, kind));

  // ------------------------------------------------------------------
  // Zero-result: cross-tab link (§16.2).
  // ------------------------------------------------------------------
  const otherTabCount = tab === 'installed' ? marketplaceCount : installedCount;
  const zeroResult = {
    active: items.length === 0,
    otherTabMatches: otherTabCount,
  };

  return {items, installedCount, marketplaceCount, kinds, zeroResult};
}
