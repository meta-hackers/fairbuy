import { describe, expect, it } from 'vitest';
import { SourceEntrySchema, type SourceEntry } from '@fairbuy/core';
import { MemoryStore } from '../src/store';
import { SourceCatalogService, sourceCatalogSeedVersion } from '../src/source-catalog';

const source = (domain: string, name: string, roles: SourceEntry['roles'] = ['seller']): SourceEntry =>
  SourceEntrySchema.parse({ domain, name, roles, verticals: ['computers'], countries: ['CH'], priority: 3 });

const v1 = [source('alpha.ch', 'Alpha'), source('beta.ch', 'Beta', ['spec'])];
const v2 = [source('alpha.ch', 'Alpha v2'), source('beta.ch', 'Beta v2', ['spec']), source('gamma.ch', 'Gamma')];

describe('source catalog seeding and overrides', () => {
  it('inserts missing entries and leaves existing rows untouched', async () => {
    const store = new MemoryStore(); const catalog = new SourceCatalogService(store);
    expect(await catalog.seed(v1, 'insert-missing', 'test')).toMatchObject({ inserted: 2, updated: 0, preserved: 0 });
    await catalog.save('alpha.ch', { ...v1[0], name: 'Alpha edited' }, 'admin');

    const report = await catalog.seed(v2, 'insert-missing', 'test');
    expect(report).toMatchObject({ inserted: 1, updated: 0, preserved: 0 });
    const view = (await catalog.views()).find(item => item.entry.domain === 'alpha.ch')!;
    expect(view).toMatchObject({ origin: 'modified', entry: { name: 'Alpha edited' }, defaultEntry: { name: 'Alpha' } });
    expect((await catalog.views()).find(item => item.entry.domain === 'gamma.ch')).toMatchObject({ origin: 'default' });
  });

  it('update-defaults refreshes defaults while preserving edits and custom entries', async () => {
    const store = new MemoryStore(); const catalog = new SourceCatalogService(store);
    await catalog.seed(v1, 'insert-missing', 'test');
    await catalog.save('alpha.ch', { ...v1[0], name: 'Alpha edited' }, 'admin');
    await catalog.save('custom.ch', source('custom.ch', 'Custom'), 'admin');

    const report = await catalog.seed(v2, 'update-defaults', 'test');
    expect(report).toMatchObject({ inserted: 1, updated: 1, preserved: 1, customUntouched: 1 });
    const views = await catalog.views();
    expect(views.find(item => item.entry.domain === 'alpha.ch')).toMatchObject({
      origin: 'modified', entry: { name: 'Alpha edited' }, defaultEntry: { name: 'Alpha v2' },
    });
    expect(views.find(item => item.entry.domain === 'beta.ch')).toMatchObject({
      origin: 'default', entry: { name: 'Beta v2' }, defaultEntry: { name: 'Beta v2' },
    });
    expect(views.find(item => item.entry.domain === 'custom.ch')).toMatchObject({ origin: 'custom', hasDefault: false });
  });

  it('sync overwrites seeded entries but does not delete custom entries', async () => {
    const store = new MemoryStore(); const catalog = new SourceCatalogService(store);
    await catalog.seed(v1, 'insert-missing', 'test');
    await catalog.save('alpha.ch', { ...v1[0], name: 'Alpha edited' }, 'admin');
    await catalog.save('custom.ch', source('custom.ch', 'Custom'), 'admin');

    await catalog.seed(v2, 'sync', 'test');
    const views = await catalog.views();
    expect(views.find(item => item.entry.domain === 'alpha.ch')).toMatchObject({ origin: 'default', entry: { name: 'Alpha v2' } });
    expect(views.find(item => item.entry.domain === 'custom.ch')).toMatchObject({ origin: 'custom' });
  });

  it('reports removed defaults without deleting them, and supports reset and delete', async () => {
    const store = new MemoryStore(); const catalog = new SourceCatalogService(store);
    await catalog.seed(v1, 'insert-missing', 'test');
    const report = await catalog.seed([source('beta.ch', 'Beta v2', ['spec'])], 'update-defaults', 'test');
    expect(report.removedDefaults).toEqual(['alpha.ch']);
    expect((await catalog.views()).some(item => item.entry.domain === 'alpha.ch')).toBe(true);

    await catalog.save('alpha.ch', { ...v1[0], name: 'Alpha edited' }, 'admin');
    await catalog.remove('alpha.ch', 'admin');
    expect((await catalog.views()).find(item => item.entry.domain === 'alpha.ch')).toMatchObject({ origin: 'default' });

    await catalog.save('custom.ch', source('custom.ch', 'Custom'), 'admin');
    await catalog.remove('custom.ch', 'admin');
    expect((await catalog.views()).some(item => item.entry.domain === 'custom.ch')).toBe(false);
  });

  it('dry runs do not write and resetAll restores defaults', async () => {
    const store = new MemoryStore(); const catalog = new SourceCatalogService(store);
    const dry = await catalog.seed(v1, 'insert-missing', 'test', true);
    expect(dry).toMatchObject({ dryRun: true, inserted: 2 });
    expect(await catalog.views()).toEqual([]);

    await catalog.seed(v1, 'insert-missing', 'test');
    await catalog.save('alpha.ch', { ...v1[0], name: 'Alpha edited' }, 'admin');
    await catalog.save('custom.ch', source('custom.ch', 'Custom'), 'admin');
    await catalog.resetAll('admin');
    const views = await catalog.views();
    expect(views).toHaveLength(2);
    expect(views.find(item => item.entry.domain === 'alpha.ch')).toMatchObject({ origin: 'default', entry: { name: 'Alpha' } });
  });

  it('derives a stable seed version independent of entry order', () => {
    expect(sourceCatalogSeedVersion(v1)).toBe(sourceCatalogSeedVersion([...v1].reverse()));
    expect(sourceCatalogSeedVersion(v1)).not.toBe(sourceCatalogSeedVersion(v2));
  });
});
