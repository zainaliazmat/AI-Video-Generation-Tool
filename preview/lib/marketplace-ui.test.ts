/**
 * Pure unit tests for deriveView — the §16.2/§16.6 derive/filter selector.
 * No IO, no React, no Next.js — just the model.
 */
import {describe, it, expect} from 'vitest';
import {deriveView} from './marketplace-ui';
import type {UnifiedItem, DeriveInput} from './marketplace-ui';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<UnifiedItem> & {id: string}): UnifiedItem {
  return {
    name: overrides.id,
    kind: 'scene',
    author: 'core',
    version: '1.0.0',
    source: 'installed',
    installed: true,
    ...overrides,
  };
}

function makeInput(overrides: Partial<DeriveInput> = {}): DeriveInput {
  return {
    installed: [],
    catalog: [],
    installedIds: new Set(),
    tab: 'installed',
    query: '',
    kind: 'all',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1) marketplace tab filtered by query — matches name/id/tags/kind/author
// ---------------------------------------------------------------------------
describe('deriveView — marketplace query filter', () => {
  const catalogItem1 = makeItem({id: 'kinetic-hook', name: 'Kinetic Hook', kind: 'hook', author: 'acme', tags: ['hook', 'kinetic'], source: 'catalog', installed: false});
  const catalogItem2 = makeItem({id: 'bold-stat', name: 'Bold Stat', kind: 'stat', author: 'studio', tags: ['number'], source: 'catalog', installed: false});
  const catalogItem3 = makeItem({id: 'wipe', name: 'Directional Wipe', kind: 'transition', author: 'studio-fps', tags: ['wipe'], source: 'catalog', installed: false});

  it('matches by name (case-insensitive)', () => {
    const out = deriveView(makeInput({tab: 'marketplace', catalog: [catalogItem1, catalogItem2, catalogItem3], query: 'kinetic'}));
    expect(out.items).toHaveLength(1);
    expect(out.items[0].id).toBe('kinetic-hook');
  });

  it('matches by id substring', () => {
    const out = deriveView(makeInput({tab: 'marketplace', catalog: [catalogItem1, catalogItem2, catalogItem3], query: 'bold'}));
    expect(out.items[0].id).toBe('bold-stat');
  });

  it('matches by tag', () => {
    const out = deriveView(makeInput({tab: 'marketplace', catalog: [catalogItem1, catalogItem2, catalogItem3], query: 'wipe'}));
    // both 'wipe' id match and 'wipe' tag match 'Directional Wipe'
    expect(out.items.some((i) => i.id === 'wipe')).toBe(true);
  });

  it('matches by kind', () => {
    const out = deriveView(makeInput({tab: 'marketplace', catalog: [catalogItem1, catalogItem2, catalogItem3], query: 'stat'}));
    expect(out.items.some((i) => i.id === 'bold-stat')).toBe(true);
  });

  it('matches by author', () => {
    const out = deriveView(makeInput({tab: 'marketplace', catalog: [catalogItem1, catalogItem2, catalogItem3], query: 'studio-fps'}));
    expect(out.items).toHaveLength(1);
    expect(out.items[0].id).toBe('wipe');
  });

  it('empty query returns all', () => {
    const out = deriveView(makeInput({tab: 'marketplace', catalog: [catalogItem1, catalogItem2, catalogItem3], query: ''}));
    expect(out.items).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 2) installed tab filtered by kind pill
// ---------------------------------------------------------------------------
describe('deriveView — installed tab kind filter', () => {
  const hookItem = makeItem({id: 'hook', kind: 'hook'});
  const sceneItem = makeItem({id: 'scene', kind: 'scene'});
  const transitionItem = makeItem({id: 'fade', kind: 'transition'});

  it('filters installed by kind pill', () => {
    const out = deriveView(makeInput({tab: 'installed', installed: [hookItem, sceneItem, transitionItem], kind: 'hook'}));
    expect(out.items).toHaveLength(1);
    expect(out.items[0].id).toBe('hook');
  });

  it('kind=all shows everything', () => {
    const out = deriveView(makeInput({tab: 'installed', installed: [hookItem, sceneItem, transitionItem], kind: 'all'}));
    expect(out.items).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 3) BOTH tab counts reflect the current query (NOT kind) — §16.2
// ---------------------------------------------------------------------------
describe('deriveView — tab counts follow query, not kind pill', () => {
  const ins1 = makeItem({id: 'hook', name: 'Hook Title', kind: 'hook'});
  const ins2 = makeItem({id: 'scene', name: 'Scene Card', kind: 'scene'});
  const cat1 = makeItem({id: 'kinetic-hook', name: 'Kinetic Hook', kind: 'hook', source: 'catalog', installed: false});
  const cat2 = makeItem({id: 'bold-stat', name: 'Bold Stat', kind: 'stat', source: 'catalog', installed: false});

  it('counts respond to query and ignore kind pill', () => {
    // query 'hook' matches ins1 (name) + cat1 (name/id); kind pill='stat' should not affect the counts
    const out = deriveView(makeInput({
      tab: 'installed',
      installed: [ins1, ins2],
      catalog: [cat1, cat2],
      query: 'hook',
      kind: 'stat',  // pill should affect grid items only
    }));
    expect(out.installedCount).toBe(1);   // ins1 matches 'hook', ins2 doesn't
    expect(out.marketplaceCount).toBe(1); // cat1 matches 'hook', cat2 doesn't
  });

  it('counts include everything when query is empty', () => {
    const out = deriveView(makeInput({tab: 'marketplace', installed: [ins1, ins2], catalog: [cat1, cat2], query: '', kind: 'hook'}));
    expect(out.installedCount).toBe(2);
    expect(out.marketplaceCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 4) installed flag derived from installedIds set — never asserted (§16.6)
// ---------------------------------------------------------------------------
describe('deriveView — installed flag derived from installedIds', () => {
  const cat1 = makeItem({id: 'wipe', name: 'Wipe', kind: 'transition', source: 'catalog', installed: false});
  const cat2 = makeItem({id: 'kinetic-hook', name: 'Kinetic', kind: 'hook', source: 'catalog', installed: false});

  it('catalog item with matching installedId gets installed:true', () => {
    const installedIds = new Set(['wipe']);
    const out = deriveView(makeInput({tab: 'marketplace', catalog: [cat1, cat2], installedIds}));
    const wipe = out.items.find((i) => i.id === 'wipe')!;
    const kinetic = out.items.find((i) => i.id === 'kinetic-hook')!;
    expect(wipe.installed).toBe(true);
    expect(kinetic.installed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5) updateAvailable: true when catalogVersion > installed version (semver)
// ---------------------------------------------------------------------------
describe('deriveView — updateAvailable semver', () => {
  // The catalog item carries catalogVersion; the installed item carries version.
  // deriveView matches them by id and computes updateAvailable on the catalog items.
  const installedOld = makeItem({id: 'wipe', kind: 'transition', version: '1.0.0', source: 'installed', installed: true});
  const catalogNewer = makeItem({id: 'wipe', kind: 'transition', version: '1.0.0', catalogVersion: '1.1.0', source: 'catalog', installed: false});
  const catalogSame = makeItem({id: 'wipe', kind: 'transition', version: '1.0.0', catalogVersion: '1.0.0', source: 'catalog', installed: false});
  const catalogOlder = makeItem({id: 'wipe', kind: 'transition', version: '1.0.0', catalogVersion: '0.9.0', source: 'catalog', installed: false});

  it('updateAvailable true when catalog version is newer', () => {
    const out = deriveView(makeInput({
      tab: 'marketplace',
      installed: [installedOld],
      catalog: [catalogNewer],
      installedIds: new Set(['wipe']),
    }));
    expect(out.items[0].updateAvailable).toBe(true);
  });

  it('updateAvailable false when catalog version is the same', () => {
    const out = deriveView(makeInput({
      tab: 'marketplace',
      installed: [installedOld],
      catalog: [catalogSame],
      installedIds: new Set(['wipe']),
    }));
    expect(out.items[0].updateAvailable).toBe(false);
  });

  it('updateAvailable false when catalog version is older', () => {
    const out = deriveView(makeInput({
      tab: 'marketplace',
      installed: [installedOld],
      catalog: [catalogOlder],
      installedIds: new Set(['wipe']),
    }));
    expect(out.items[0].updateAvailable).toBe(false);
  });

  it('updateAvailable undefined when not installed', () => {
    const out = deriveView(makeInput({
      tab: 'marketplace',
      installed: [],
      catalog: [catalogNewer],
      installedIds: new Set(),
    }));
    // Not installed → no update available
    expect(out.items[0].updateAvailable).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// 6) zeroResult.active and otherTabMatches — §16.2 cross-tab
// ---------------------------------------------------------------------------
describe('deriveView — zeroResult', () => {
  const ins1 = makeItem({id: 'hook', name: 'Hook Title', kind: 'hook'});
  const cat1 = makeItem({id: 'kinetic-hook', name: 'Kinetic Hook', kind: 'hook', source: 'catalog', installed: false});

  it('zeroResult.active when active tab has 0 matches', () => {
    // query 'zzz' matches nothing
    const out = deriveView(makeInput({tab: 'installed', installed: [ins1], catalog: [cat1], query: 'zzz'}));
    expect(out.zeroResult.active).toBe(true);
    expect(out.zeroResult.otherTabMatches).toBe(0); // also 0 in marketplace
  });

  it('otherTabMatches = count in inactive tab', () => {
    // query 'kinetic' matches cat1 but not ins1
    const out = deriveView(makeInput({tab: 'installed', installed: [ins1], catalog: [cat1], query: 'kinetic'}));
    expect(out.zeroResult.active).toBe(true);
    expect(out.zeroResult.otherTabMatches).toBe(1);
  });

  it('zeroResult.active false when there are matches', () => {
    const out = deriveView(makeInput({tab: 'installed', installed: [ins1], catalog: [cat1], query: 'hook'}));
    expect(out.zeroResult.active).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7) kinds facet = kinds present in the active tab's query-filtered set (before kind pill)
// ---------------------------------------------------------------------------
describe('deriveView — kinds facets', () => {
  const ins1 = makeItem({id: 'hook', kind: 'hook'});
  const ins2 = makeItem({id: 'scene', kind: 'scene'});
  const ins3 = makeItem({id: 'fade', kind: 'transition', name: 'Fade Transition'});

  it('kinds = all kinds in active tab (before kind pill)', () => {
    const out = deriveView(makeInput({tab: 'installed', installed: [ins1, ins2, ins3], kind: 'hook'}));
    // The kind pill filters items but NOT the kinds facet
    expect(out.kinds).toContain('hook');
    expect(out.kinds).toContain('scene');
    expect(out.kinds).toContain('transition');
  });

  it('kinds respond to query (narrow when query narrows)', () => {
    // query 'fade' only matches ins3 → only 'transition' kind present
    const out = deriveView(makeInput({tab: 'installed', installed: [ins1, ins2, ins3], query: 'fade'}));
    expect(out.kinds).toEqual(['transition']);
  });

  it('kinds are sorted and unique', () => {
    const out = deriveView(makeInput({tab: 'installed', installed: [ins1, ins2, ins3]}));
    const sorted = [...out.kinds].sort();
    expect(out.kinds).toEqual(sorted);
  });
});

// ---------------------------------------------------------------------------
// 8) uncommitted flag preserved for installed non-catalog items
// ---------------------------------------------------------------------------
describe('deriveView — uncommitted badge preserved', () => {
  const dirtyItem = makeItem({id: 'hook', kind: 'hook', uncommitted: true, source: 'installed', installed: true});
  const cleanItem = makeItem({id: 'scene', kind: 'scene', uncommitted: false, source: 'installed', installed: true});

  it('uncommitted:true item preserves the flag in output', () => {
    const out = deriveView(makeInput({tab: 'installed', installed: [dirtyItem, cleanItem]}));
    const hook = out.items.find((i) => i.id === 'hook')!;
    expect(hook.uncommitted).toBe(true);
  });

  it('uncommitted:false item has falsy flag', () => {
    const out = deriveView(makeInput({tab: 'installed', installed: [dirtyItem, cleanItem]}));
    const scene = out.items.find((i) => i.id === 'scene')!;
    expect(scene.uncommitted).toBeFalsy();
  });
});
