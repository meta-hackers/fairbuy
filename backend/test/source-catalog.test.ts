import { describe, expect, it, vi } from 'vitest';
import { SourceEntrySchema, type SourceEntry } from '@fairbuy/core';
import { SourceCatalogService, sourceCatalogVersion, type PersistedSourceCatalog } from '../src/source-catalog';
import { MemoryStore } from '../src/store';

const config = { CATALOG_URL: 'https://example.test/sources.json' };
const source = (domain: string, name = domain, roles: SourceEntry['roles'] = ['seller']): SourceEntry =>
  SourceEntrySchema.parse({ domain, name, roles, verticals: ['computers'], countries: ['CH'], priority: 3 });
const envelope = (entries: unknown[]) => ({ schemaVersion: 1, updatedAt: new Date().toISOString(), entries });
const json = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
const persisted = (entries: SourceEntry[]): PersistedSourceCatalog => ({
  entries, url: config.CATALOG_URL, fetchedAt: '2026-01-02T03:04:05.000Z', version: sourceCatalogVersion(entries),
});
const fallback = [source('fallback.ch', 'Fallback')];
const remote = [source('remote.ch', 'Remote'), source('reference.ch', 'Reference', ['spec'])];

describe('database-backed source catalog', () => {
  it('starts empty when the database has no catalog and reports its metadata', async () => {
    const service = new SourceCatalogService(config, new MemoryStore(), vi.fn());
    expect(await service.effective()).toEqual([]);
    expect(service.status()).toMatchObject({
      source: 'database', url: config.CATALOG_URL, fetchedAt: null, count: 0,
      version: sourceCatalogVersion([]), error: null,
    });
  });

  it('persists and swaps the whole catalog on a successful sync', async () => {
    const store = new MemoryStore();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(envelope(remote)));
    const service = new SourceCatalogService(config, store, fetcher);
    const status = await service.sync();
    expect(status).toMatchObject({ source: 'github', count: 2, error: null });
    expect(status.fetchedAt).not.toBeNull();
    expect(status.version).toBe(sourceCatalogVersion(remote));
    expect(await service.effective()).toEqual(remote);
    expect((await store.loadSourceCatalog())?.entries).toEqual(remote);
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe(config.CATALOG_URL);
    expect(init).toMatchObject({ redirect: 'error', cache: 'no-store' });
  });

  it('loads the last complete sync from the database after a restart', async () => {
    const store = new MemoryStore();
    await store.replaceSourceCatalog(persisted(remote));
    const service = new SourceCatalogService(config, store, vi.fn());
    expect(await service.effective()).toEqual(remote);
    expect(service.status()).toMatchObject({
      source: 'database', count: 2, fetchedAt: persisted(remote).fetchedAt, version: sourceCatalogVersion(remote), error: null,
    });
  });

  it('replaces every persisted row on each sync instead of merging', async () => {
    const store = new MemoryStore();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(envelope(remote)))
      .mockResolvedValueOnce(json(envelope([source('only.ch', 'Only')])));
    const service = new SourceCatalogService(config, store, fetcher);
    await service.sync();
    await service.sync();
    expect((await store.loadSourceCatalog())?.entries).toEqual([source('only.ch', 'Only')]);
  });

  it('accepts catalog entries with a new vertical key', async () => {
    const extended = [{ ...remote[0], verticals: ['instruments'] }];
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(envelope(extended)));
    const service = new SourceCatalogService(config, new MemoryStore(), fetcher);
    const status = await service.sync();
    expect(status).toMatchObject({ source: 'github', count: 1, error: null });
    expect((await service.effective())[0].verticals).toEqual(['instruments']);
  });

  it.each([
    ['network failure', vi.fn<typeof fetch>().mockRejectedValue(new Error('offline')), 'host could not be reached'],
    ['HTTP failure', vi.fn<typeof fetch>().mockResolvedValue(new Response('no', { status: 503 })), 'request failed (503)'],
    ['invalid JSON', vi.fn<typeof fetch>().mockResolvedValue(new Response('not json', { status: 200 })), 'not valid JSON'],
    ['wrong schema', vi.fn<typeof fetch>().mockResolvedValue(json({ schemaVersion: 2, entries: remote })), 'schemaVersion 1'],
    ['invalid entry', vi.fn<typeof fetch>().mockResolvedValue(json(envelope([{ domain: 'bad host' }]))), 'validation issue(s)'],
    ['empty catalog', vi.fn<typeof fetch>().mockResolvedValue(json(envelope([]))), 'has no entries'],
    ['oversized catalog', vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(512 * 1024 + 1), { status: 200 })), 'too large'],
  ])('keeps the last-known-good catalog on %s', async (_label, fetcher, message) => {
    const store = new MemoryStore();
    await store.replaceSourceCatalog(persisted(fallback));
    const service = new SourceCatalogService(config, store, fetcher);
    const status = await service.sync();
    expect(status).toMatchObject({ source: 'database', count: 1, error: expect.stringContaining(message) });
    expect(await service.effective()).toEqual(fallback);
    expect((await store.loadSourceCatalog())?.entries).toEqual(fallback);
  });

  it('keeps a previously synced catalog when a later sync fails', async () => {
    const store = new MemoryStore();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(envelope(remote)))
      .mockResolvedValueOnce(new Response('no', { status: 500 }));
    const service = new SourceCatalogService(config, store, fetcher);
    await service.sync();
    const status = await service.sync();
    expect(status).toMatchObject({ source: 'github', count: 2, error: expect.stringContaining('request failed') });
    expect(await service.effective()).toEqual(remote);
    expect((await store.loadSourceCatalog())?.entries).toEqual(remote);
  });

  it('keeps the previous catalog when the database write fails', async () => {
    const store = new MemoryStore();
    await store.replaceSourceCatalog(persisted(fallback));
    const repository = { loadSourceCatalog: store.loadSourceCatalog.bind(store), replaceSourceCatalog: vi.fn().mockRejectedValue(new Error('db offline')) };
    const service = new SourceCatalogService(config, repository, vi.fn<typeof fetch>().mockResolvedValue(json(envelope(remote))));
    const status = await service.sync();
    expect(status).toMatchObject({ source: 'database', count: 1, error: expect.stringContaining('saved to the database') });
    expect(await service.effective()).toEqual(fallback);
  });

  it('rejects missing and non-HTTPS catalog URLs', async () => {
    const missing = new SourceCatalogService({ CATALOG_URL: '' }, new MemoryStore(), vi.fn());
    expect(await missing.sync()).toMatchObject({ error: expect.stringContaining('No catalog URL') });
    const insecure = new SourceCatalogService({ CATALOG_URL: 'http://example.test/sources.json' }, new MemoryStore(), vi.fn());
    expect(await insecure.sync()).toMatchObject({ error: expect.stringContaining('HTTPS') });
  });

  it('derives a stable version independent of entry order', () => {
    expect(sourceCatalogVersion(remote)).toBe(sourceCatalogVersion([...remote].reverse()));
    expect(sourceCatalogVersion(remote)).not.toBe(sourceCatalogVersion(fallback));
  });
});
