import { EventEmitter } from 'node:events';
import { lookup } from 'node:dns/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Product } from '@fairbuy/core';
import { findSellerImage } from '../src/product-images';
import { clearPublicImageCache, configureImageProxy, fetchPublicImage, getPublicImage } from '../src/image-proxy';
import { ProductImageResolver } from '../src/product-image-resolver';
import { DiagnosticStore } from '../src/diagnostics';

const network = vi.hoisted(() => ({
  responses: new Map<string, { status?: number; headers?: Record<string, string>; body?: string | Buffer; hang?: boolean }>(),
  requests: [] as { url: string; headers: Record<string, string> }[],
}));
vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]) }));
vi.mock('node:https', () => ({
  get: (url: string, options: { headers: Record<string, string>; lookup: Function }, callback: Function) => {
    const request = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    network.requests.push({ url, headers: options.headers });
    queueMicrotask(() => options.lookup(new URL(url).hostname, { all: true }, (error: Error | null) => {
      if (error) { request.emit('error', error); return; }
      const fixture = network.responses.get(url) ?? { status: 404 };
      let destroyed = false;
      const response = Object.assign(new EventEmitter(), {
        statusCode: fixture.status ?? 200, headers: fixture.headers ?? { 'content-type': 'text/html' },
        destroy: () => { destroyed = true; },
      });
      callback(response);
      if (!destroyed && !fixture.hang) {
        response.emit('data', Buffer.from(fixture.body ?? ''));
        if (!destroyed) response.emit('end');
      }
    }));
    return request;
  },
}));

const shop = 'https://shop.fairbuy-fixture.org/product';
const cdn = 'https://images.seller-cdn.org';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
function product(sources = [shop], imageUrl: string | null = null): Product {
  return {
    id: 'test-product', name: 'Test product', summary: '', why: '', tradeoffs: [], imageUrl,
    offers: sources.map((provenanceUrl, i) => ({ id: `offer-${i}`, mode: 'live', provenanceUrl } as Product['offers'][number])),
  };
}
function image(url: string) { network.responses.set(url, { headers: { 'content-type': 'image/png' }, body: png }); }
function wsrv(url: string) {
  const proxy = new URL('https://wsrv.nl/');
  proxy.searchParams.set('url', url);
  proxy.searchParams.set('w', '600');
  proxy.searchParams.set('output', 'webp');
  return proxy.toString();
}

beforeEach(() => {
  network.requests.length = 0;
  network.responses.clear();
  clearPublicImageCache();
  configureImageProxy('wsrv');
  vi.mocked(lookup).mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never);
});

describe('image recovery end to end (mock public network)', () => {
  it('recovers blocked image bytes through wsrv and caches them under the original URL', async () => {
    const url = `${cdn}/blocked.png?width=1200&quality=90`;
    network.responses.set(url, { status: 403 });
    image(wsrv(url));
    const [first, second] = await Promise.all([getPublicImage(url, undefined, shop), getPublicImage(url, undefined, shop)]);
    expect(first?.body).toEqual(png);
    expect(second?.body).toEqual(png);
    expect(network.requests.map(r => r.url)).toEqual([url, wsrv(url)]);
    expect(network.requests[1].headers.Referer).toBeUndefined();
    expect(Object.keys(network.requests[1].headers)).not.toContain('Authorization');
    expect(Object.keys(network.requests[1].headers)).not.toContain('Cookie');
    expect((await getPublicImage(url))?.body).toEqual(png);
    expect(network.requests).toHaveLength(2);
  });
  it('recovers an extracted image via wsrv before scraping a blocked storefront', async () => {
    const url = `${cdn}/blocked.png`;
    network.responses.set(url, { status: 403 });
    image(wsrv(url));
    expect(await findSellerImage(product([shop], url))).toBe(url);
    expect(network.requests.map(r => r.url)).toEqual([url, wsrv(url)]);
  });
  it('can opt out of the third-party proxy', async () => {
    configureImageProxy('disabled');
    const url = `${cdn}/blocked.png`;
    network.responses.set(url, { status: 403 });
    image(wsrv(url));
    expect(await getPublicImage(url)).toBeNull();
    expect(network.requests.map(r => r.url)).toEqual([url]);
  });
  it.each([404, 429, 500])('does not send HTTP %i failures through wsrv', async status => {
    const url = `${cdn}/missing.png`;
    network.responses.set(url, { status });
    image(wsrv(url));
    expect(await getPublicImage(url)).toBeNull();
    expect(network.requests.map(r => r.url)).toEqual([url]);
  });
  it('never nests a proxy fallback or retries a failed wsrv response', async () => {
    const url = `${cdn}/blocked.png`;
    network.responses.set(url, { status: 403 });
    network.responses.set(wsrv(url), { status: 403 });
    expect(await getPublicImage(url)).toBeNull();
    expect(network.requests.map(r => r.url)).toEqual([url, wsrv(url)]);
    network.requests.length = 0;
    expect(await fetchPublicImage(wsrv(url))).toBeNull();
    expect(network.requests.map(r => r.url)).toEqual([wsrv(url)]);
  });
  it('validates proxy responses instead of accepting HTML or oversized images', async () => {
    const url = `${cdn}/blocked.png`;
    network.responses.set(url, { status: 403 });
    network.responses.set(wsrv(url), { headers: { 'content-type': 'image/png' }, body: '<html>blocked</html>' });
    expect(await getPublicImage(url)).toBeNull();
    network.responses.set(wsrv(url), { headers: { 'content-type': 'image/png', 'content-length': '6000000' }, body: png });
    expect(await getPublicImage(url)).toBeNull();
  });
  it('rejects unsafe redirects from wsrv without following them', async () => {
    const url = `${cdn}/blocked.png`;
    network.responses.set(url, { status: 403 });
    network.responses.set(wsrv(url), { status: 302, headers: { location: 'https://127.0.0.1/private.png' } });
    expect(await getPublicImage(url)).toBeNull();
    expect(network.requests.map(r => r.url)).toEqual([url, wsrv(url)]);
  });
  it('bounds a stalled proxy request to eight seconds', async () => {
    vi.useFakeTimers();
    try {
      const url = `${cdn}/blocked.png`;
      network.responses.set(url, { status: 403 });
      network.responses.set(wsrv(url), { headers: { 'content-type': 'image/png' }, hang: true });
      const pending = getPublicImage(url);
      await vi.advanceTimersByTimeAsync(8001);
      expect(await pending).toBeNull();
      expect(network.requests.map(r => r.url)).toEqual([url, wsrv(url)]);
    } finally { vi.useRealTimers(); }
  });
  it('records the origin refusal and proxy recovery together without logging image URLs', async () => {
    const url = `${cdn}/blocked.png?token=public-image-query`;
    network.responses.set(url, { status: 403 });
    image(wsrv(url));
    const diagnostics = new DiagnosticStore();
    const traceId = 'a9911234-5555-4444-8888-123456789012';
    await diagnostics.capture({ traceId, source: 'server', sessionId: null, roundId: null, productId: null }, () => getPublicImage(url));
    const { events } = await diagnostics.list({ traceId, page: 1 });
    expect(events.map(event => event.event)).toEqual(['image.fetch.unavailable', 'image.fallback.started', 'image.fetch.completed']);
    expect(events.at(-1)?.details).toMatchObject({ domain: 'wsrv.nl', status: 200 });
    expect(JSON.stringify(events)).not.toContain('public-image-query');
  });
  it('does not use wsrv to route around private DNS, unsafe redirects or cancellation', async () => {
    const url = `${cdn}/blocked.png`;
    network.responses.set(url, { status: 403 });
    image(wsrv(url));
    vi.mocked(lookup).mockResolvedValue([{ address: '10.0.0.1', family: 4 }] as never);
    expect(await getPublicImage(url)).toBeNull();
    expect(network.requests.map(r => r.url)).toEqual([url]);
    vi.mocked(lookup).mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never);
    network.responses.set(url, { status: 302, headers: { location: 'https://localhost/private.png' } });
    expect(await getPublicImage(url)).toBeNull();
    const controller = new AbortController();
    controller.abort();
    expect(await getPublicImage(url, controller.signal)).toBeNull();
    expect(network.requests.map(r => r.url)).toEqual([url, url]);
  });
  it('tries the next metadata candidate after a dead or fake first image, and warms the proxy cache', async () => {
    network.responses.set(shop, { body: `<script type="application/ld+json">${JSON.stringify({
      '@type': 'Product', image: [`${cdn}/dead.png`, `${cdn}/challenge.png`, `${cdn}/working.png`],
    })}</script>` });
    network.responses.set(`${cdn}/challenge.png`, { headers: { 'content-type': 'image/png' }, body: '<html>Access denied</html>' });
    image(`${cdn}/working.png`);
    expect(await findSellerImage(product())).toBe(`${cdn}/working.png`);
    expect(network.requests.at(-1)?.headers.Referer).toBe('https://shop.fairbuy-fixture.org/');
    const requests = network.requests.length;
    expect((await getPublicImage(`${cdn}/working.png`))?.body).toEqual(png);
    expect(network.requests).toHaveLength(requests);
  });

  it('falls back to another seller when the first storefront blocks us', async () => {
    network.responses.set(shop, { status: 403 });
    network.responses.set(`${shop}-other`, { body: `<meta property="og:image" content="${cdn}/other.png">` });
    image(`${cdn}/other.png`);
    expect(await findSellerImage(product([shop, `${shop}-other`], `${cdn}/missing.png`))).toBe(`${cdn}/other.png`);
  });

  it('can use an accepted working image without scraping a blocked storefront', async () => {
    image(`${cdn}/accepted.png`);
    expect(await findSellerImage(product([shop], `${cdn}/accepted.png`))).toBe(`${cdn}/accepted.png`);
    expect(network.requests.map(r => r.url)).toEqual([`${cdn}/accepted.png`]);
  });

  it('keeps useful head metadata when a storefront exceeds the HTML size limit', async () => {
    network.responses.set(shop, { body: `<meta property="og:image" content="${cdn}/large-page.png">${' '.repeat(3 * 1024 * 1024)}` });
    image(`${cdn}/large-page.png`);
    expect(await findSellerImage(product())).toBe(`${cdn}/large-page.png`);
  });

  it('recovers missing images for saved products and shares concurrent loads', async () => {
    network.responses.set(shop, { body: `<meta property="og:image" content="${cdn}/saved.png">` });
    image(`${cdn}/saved.png`);
    const resolver = new ProductImageResolver();
    const [first, second] = await Promise.all([resolver.get(product()), resolver.get(product())]);
    expect(first?.body).toEqual(png);
    expect(second?.body).toEqual(png);
    expect(network.requests.filter(r => r.url === shop)).toHaveLength(1);
    await resolver.get(product());
    expect(network.requests).toHaveLength(2);
  });

  it('briefly caches misses but immediately tries new seller evidence', async () => {
    const resolver = new ProductImageResolver();
    expect(await resolver.get(product())).toBeNull();
    expect(await resolver.get(product())).toBeNull();
    expect(network.requests).toHaveLength(1);
    network.responses.set(`${shop}-new`, { body: `<meta property="og:image" content="${cdn}/new.png">` });
    image(`${cdn}/new.png`);
    expect((await resolver.get(product([`${shop}-new`])))?.body).toEqual(png);
  });

  it('retries a transient miss after its short TTL and deduplicates direct proxy loads', async () => {
    const resolver = new ProductImageResolver();
    expect(await resolver.get(product())).toBeNull();
    network.responses.set(shop, { body: `<meta property="og:image" content="${cdn}/recovered.png">` });
    image(`${cdn}/recovered.png`);
    expect(await resolver.get(product())).toBeNull();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61000);
    try { expect((await resolver.get(product()))?.body).toEqual(png); }
    finally { clock.mockRestore(); }
    image(`${cdn}/shared.png`);
    const before = network.requests.length;
    const loaded = await Promise.all([getPublicImage(`${cdn}/shared.png`), getPublicImage(`${cdn}/shared.png`)]);
    expect(loaded.every(value => value?.body.equals(png))).toBe(true);
    expect(network.requests).toHaveLength(before + 1);
  });

  it('rejects unsafe redirects and DNS answers before accepting image bytes', async () => {
    network.responses.set(`${cdn}/redirect.png`, { status: 302, headers: { location: 'https://127.0.0.1/private.png' } });
    expect(await fetchPublicImage(`${cdn}/redirect.png`)).toBeNull();
    expect(network.requests).toHaveLength(1);
    network.responses.set(shop, { status: 302, headers: { location: 'https://localhost/private' } });
    expect(await findSellerImage(product())).toBeNull();
    expect(network.requests).toHaveLength(2);
    vi.mocked(lookup).mockResolvedValue([{ address: '10.0.0.1', family: 4 }] as never);
    image(`${cdn}/private.png`);
    expect(await fetchPublicImage(`${cdn}/private.png`)).toBeNull();
  });

  it('rejects oversized and empty images and stops promptly on abort', async () => {
    network.responses.set(`${cdn}/huge.png`, { headers: { 'content-type': 'image/png', 'content-length': '6000000' }, body: png });
    network.responses.set(`${cdn}/empty.png`, { headers: { 'content-type': 'image/png' } });
    expect(await fetchPublicImage(`${cdn}/huge.png`)).toBeNull();
    expect(await fetchPublicImage(`${cdn}/empty.png`)).toBeNull();
    network.responses.set(shop, { hang: true });
    const controller = new AbortController();
    const pending = findSellerImage(product(), null, controller.signal);
    controller.abort();
    expect(await pending).toBeNull();
  });
});
