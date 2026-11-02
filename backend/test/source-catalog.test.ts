import { describe, expect, it, vi } from 'vitest';
import { SourceEntrySchema, type SourceEntry } from '@fairbuy/core';
import { SourceCatalogService, sourceCatalogVersion } from '../src/source-catalog';

const config = { CATALOG_URL: 'https://example.test/sources.json' };
const source = (domain: string, name = domain, roles: SourceEntry['roles'] = ['seller']): SourceEntry =>
  SourceEntrySchema.parse({ domain, name, roles, verticals: ['computers'], countries: ['CH'], priority: 3 });
const envelope = (entries: unknown[]) => ({ schemaVersion: 1, updatedAt: new Date().toISOString(), entries });
const json = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
const fallback = [source('fallback.ch', 'Fallback')];
const remote = [source('remote.ch', 'Remote'), source('reference.ch', 'Reference', ['spec'])];

describe('remote source catalog cache', () => {
  it('starts from the bundled fallback and reports its metadata', async () => {
    const service = new SourceCatalogService(config, vi.fn(), fallback);
    expect(await service.effective()).toEqual(fallback);
    expect(service.status()).toMatchObject({
      source: 'fallback', url: config.CATALOG_URL, fetchedAt: null, count: 1,
      version: sourceCatalogVersion(fallback), error: null,
    });
  });

  it('validates and swaps the whole catalog on a successful sync', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(envelope(remote)));
    const service = new SourceCatalogService(config, fetcher, fallback);
    const status = await service.sync();
    expect(status).toMatchObject({ source: 'github', count: 2, error: null });
    expect(status.fetchedAt).not.toBeNull();
    expect(status.version).toBe(sourceCatalogVersion(remote));
    expect(await service.effective()).toEqual(remote);
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe(config.CATALOG_URL);
    expect(init).toMatchObject({ redirect: 'error', cache: 'no-store' });
  });

  it('accepts catalog entries with a new vertical key', async () => {
    const extended = [{ ...remote[0], verticals: ['instruments'] }];
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(envelope(extended)));
    const service = new SourceCatalogService(config, fetcher, fallback);
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
    const service = new SourceCatalogService(config, fetcher, fallback);
    const status = await service.sync();
    expect(status).toMatchObject({ source: 'fallback', count: 1, error: expect.stringContaining(message) });
    expect(await service.effective()).toEqual(fallback);
  });

  it('keeps a previously synced catalog when a later sync fails', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(envelope(remote)))
      .mockResolvedValueOnce(new Response('no', { status: 500 }));
    const service = new SourceCatalogService(config, fetcher, fallback);
    await service.sync();
    const status = await service.sync();
    expect(status).toMatchObject({ source: 'github', count: 2, error: expect.stringContaining('request failed') });
    expect(await service.effective()).toEqual(remote);
  });

  it('rejects missing and non-HTTPS catalog URLs', async () => {
    const missing = new SourceCatalogService({ CATALOG_URL: '' }, vi.fn(), fallback);
    expect(await missing.sync()).toMatchObject({ error: expect.stringContaining('No catalog URL') });
    const insecure = new SourceCatalogService({ CATALOG_URL: 'http://example.test/sources.json' }, vi.fn(), fallback);
    expect(await insecure.sync()).toMatchObject({ error: expect.stringContaining('HTTPS') });
  });

  it('derives a stable version independent of entry order', () => {
    expect(sourceCatalogVersion(remote)).toBe(sourceCatalogVersion([...remote].reverse()));
    expect(sourceCatalogVersion(remote)).not.toBe(sourceCatalogVersion(fallback));
  });
});
