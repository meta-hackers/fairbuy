import { EventEmitter } from 'node:events';
import { lookup } from 'node:dns/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Product } from '@fairbuy/core';
import { findSellerImage } from '../src/product-images';
import { clearPublicImageCache, fetchPublicImage, getPublicImage } from '../src/image-proxy';
import { ProductImageResolver } from '../src/product-image-resolver';

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

beforeEach(() => {
  network.requests.length = 0;
  network.responses.clear();
  clearPublicImageCache();
  vi.mocked(lookup).mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never);
});

describe('image recovery end to end (mock public network)', () => {
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
