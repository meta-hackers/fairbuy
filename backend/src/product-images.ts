import { lookup } from 'node:dns/promises';
import { get } from 'node:https';
import type { Product } from '@fairbuy/core';
import { safeUrl } from './links';
import { publicImagePageAddress } from './public-network';
import { getPublicImage } from './image-proxy';
import { logger } from './logger';

export { publicImagePageAddress } from './public-network';

const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const PAGE_TIMEOUT_MS = 6000;
const MAX_REDIRECTS = 3;
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const GENERIC_IMAGE = /(^|[/_.-])(logo|logos|sprite|sprites|favicon|placeholder|no-image|noimage|coming-soon|default-image|defaultimage|site-icon|brand-logo)([/_.-]|$)/i;

interface Page { html: string; url: string }
interface PageResponse { status: number; location: string | null; html: string | null }

function requestPage(url: string, signal?: AbortSignal): Promise<PageResponse> {
  return new Promise(resolve => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: PageResponse) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      resolve(result);
    };
    const cancel = () => { request.destroy(); finish({ status: 0, location: null, html: null }); };
    if (signal?.aborted) { finish({ status: 0, location: null, html: null }); return; }
    const request = get(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': BROWSER_USER_AGENT,
      },
      // No automatic redirects: every hop must pass through safeUrl and the
      // public-IPv4 DNS check. This prevents a seller redirecting us into a
      // private network.
      lookup: (hostname, options, callback) => {
        void lookup(hostname, { family: 4, all: true }).then(addresses => {
          if (!addresses.length || addresses.some(a => !publicImagePageAddress(a.address))) {
            callback(new Error('Non-public seller address'), '', 4); return;
          }
          if (options.all) callback(null, [addresses[0]]);
          else callback(null, addresses[0].address, 4);
        }).catch(error => callback(error, '', 4));
      },
    }, response => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        const location = typeof response.headers.location === 'string' ? response.headers.location : null;
        response.destroy(); finish({ status, location, html: null }); return;
      }
      const contentType = response.headers['content-type'] ?? '';
      if (status !== 200 || !/(text\/html|application\/xhtml\+xml)/i.test(contentType)) {
        response.destroy(); finish({ status, location: null, html: null }); return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        // Large storefronts often exceed the limit, but their head already
        // contains usable metadata. Keep the bounded prefix instead of losing it.
        if (size > MAX_PAGE_BYTES) {
          chunks.push(chunk.subarray(0, Math.max(0, MAX_PAGE_BYTES - (size - chunk.length))));
          response.destroy(); finish({ status, location: null, html: Buffer.concat(chunks).toString('utf8') });
        }
        else chunks.push(chunk);
      });
      response.on('end', () => finish({ status, location: null, html: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', () => finish({ status: 0, location: null, html: null }));
    });
    request.on('error', () => finish({ status: 0, location: null, html: null }));
    timer = setTimeout(() => { request.destroy(); finish({ status: 0, location: null, html: null }); }, PAGE_TIMEOUT_MS);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

async function readPage(value: string, signal?: AbortSignal): Promise<Page | null> {
  let url = safeUrl(value);
  if (!url) return null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (signal?.aborted) return null;
    const result = await requestPage(url, signal);
    if (result.status >= 300 && result.status < 400 && result.location) {
      try { url = safeUrl(new URL(result.location, url).toString()); } catch { return null; }
      if (!url) return null;
      continue;
    }
    if (result.html === null) logger.info('image.page.unavailable', { host: new URL(url).hostname, status: result.status });
    return result.html !== null ? { html: result.html, url } : null;
  }
  return null;
}

function decode(value: string) {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, entity => {
    const named: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const number = entity[2].toLowerCase() === 'x' ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
  });
}

function attributes(tag: string): Map<string, string> {
  return new Map([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)]
    .map(match => [match[1].toLowerCase(), decode(match[2] ?? match[3] ?? match[4])]));
}

function srcsetUrls(value: string): string[] {
  return value.split(',').map(part => part.trim().split(/\s+/)[0]).filter(Boolean);
}

function productJsonImages(value: unknown, output: string[]): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { value.forEach(item => productJsonImages(item, output)); return; }
  const object = value as Record<string, unknown>;
  const types = Array.isArray(object['@type']) ? object['@type'] : [object['@type']];
  if (types.includes('Product')) {
    for (const image of Array.isArray(object.image) ? object.image : [object.image]) {
      const url = typeof image === 'string' ? image : image && typeof image === 'object' ? (image as Record<string, unknown>).url ?? (image as Record<string, unknown>).contentUrl : null;
      if (typeof url === 'string') output.push(url);
    }
  }
  if (object['@graph']) productJsonImages(object['@graph'], output);
  if (object.mainEntity) productJsonImages(object.mainEntity, output);
}

/** Reject obvious site furniture so a logo is not presented as the product. */
export function isGenericImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    let path = url.pathname;
    try { path = decodeURIComponent(path); } catch { /* Keep the encoded path. */ }
    return /\.svg$/i.test(path) || GENERIC_IMAGE.test(path);
  } catch { return true; }
}

/**
 * Metadata is grounded in the seller HTML. Product-specific metadata (JSON-LD,
 * `itemprop=image`, `link rel=image_src`) is preferred over generic social
 * cards, and obvious logos/placeholders are skipped.
 */
export function sellerImages(html: string, pageUrl: string): string[] {
  const candidates: string[] = [];

  for (const script of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    try { productJsonImages(JSON.parse(script[1]), candidates); } catch { /* Invalid seller metadata is optional. */ }
  }

  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const values = attributes(tag);
    if ((values.get('rel') ?? '').toLowerCase().split(/\s+/).includes('image_src') && values.get('href')) candidates.push(values.get('href')!);
  }

  const meta: [string, string][] = [];
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const values = attributes(tag);
    const key = values.get('property') ?? values.get('name') ?? values.get('itemprop');
    if (key && values.get('content')) meta.push([key.toLowerCase(), values.get('content')!]);
  }
  for (const key of ['image', 'og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src']) {
    for (const [name, content] of meta) if (name === key) candidates.push(content);
  }

  for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
    const values = attributes(tag);
    if (!(values.get('itemprop') ?? '').toLowerCase().split(/\s+/).includes('image')) continue;
    if (values.get('content')) candidates.push(values.get('content')!);
    const srcset = values.get('data-srcset') ?? values.get('srcset');
    if (srcset) candidates.push(...srcsetUrls(srcset).reverse());
    if (values.get('data-src')) candidates.push(values.get('data-src')!);
    if (values.get('data-original')) candidates.push(values.get('data-original')!);
    if (values.get('src')) candidates.push(values.get('src')!);
  }

  const images = new Set<string>();
  for (const candidate of candidates) {
    try {
      const image = safeUrl(new URL(candidate, pageUrl).toString());
      if (image && image.length <= 2000 && !isGenericImageUrl(image)) images.add(image);
    } catch { /* Try the next metadata image. */ }
  }
  return [...images];
}

export function sellerImage(html: string, pageUrl: string): string | null {
  return sellerImages(html, pageUrl)[0] ?? null;
}

/** True when a candidate image is explicitly referenced by the seller HTML. */
export function imageMentionedInHtml(html: string, value: string): boolean {
  return decode(html).includes(value);
}

export async function findSellerImage(product: Product, preferredImage: string | null = product.imageUrl, signal?: AbortSignal): Promise<string | null> {
  const bounded = AbortSignal.timeout(20000);
  signal = signal ? AbortSignal.any([signal, bounded]) : bounded;
  const offers = product.offers.filter(offer => offer.mode === 'live');
  const checked = new Set<string>();
  const usable = async (url: string, referer?: string) => {
    const key = JSON.stringify([url, referer]);
    if (checked.has(key) || isGenericImageUrl(url) || signal.aborted) return false;
    checked.add(key);
    return !!await getPublicImage(url, signal, referer);
  };
  // An accepted extraction URL may work even when the storefront blocks HTML
  // scraping. Validate and warm the byte cache, rather than publishing a dead URL.
  if (preferredImage && await usable(preferredImage, offers[0]?.provenanceUrl)) return preferredImage;
  for (const offer of offers) {
    if (signal.aborted) return null;
    const source = offer.provenanceUrl;
    if (!source) continue;
    const page = await readPage(source, signal);
    if (!page) continue;
    // A broken first candidate must not hide other images or other sellers.
    const candidates = sellerImages(page.html, page.url).slice(0, 6);
    if (!candidates.length) logger.info('image.page.no_candidates', { host: new URL(page.url).hostname });
    for (const image of candidates) {
      if (await usable(image, page.url)) return image;
    }
  }
  return null;
}
