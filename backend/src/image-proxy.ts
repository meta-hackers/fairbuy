import { lookup } from 'node:dns/promises';
import { get } from 'node:https';
import { safeUrl } from './links';
import { publicImagePageAddress } from './public-network';

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const REQUEST_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX_BYTES = 32 * 1024 * 1024;
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export interface PublicImage { body: Buffer; contentType: string }

interface ImageResponse { status: number; location: string | null; image: PublicImage | null }
interface CacheEntry { image: PublicImage; expiresAt: number }

// Process-local LRU. Browser/CDN caching is the primary cache; this avoids
// repeated upstream fetches when several clients request the same product.
const cache = new Map<string, CacheEntry>();
let cacheBytes = 0;

function readCache(key: string): PublicImage | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    cacheBytes -= entry.image.body.length;
    return null;
  }
  // Refresh insertion order so the least recently used entry is evicted.
  cache.delete(key);
  cache.set(key, entry);
  return entry.image;
}

function writeCache(key: string, image: PublicImage) {
  const previous = cache.get(key);
  if (previous) {
    cache.delete(key);
    cacheBytes -= previous.image.body.length;
  }
  cache.set(key, { image, expiresAt: Date.now() + CACHE_TTL_MS });
  cacheBytes += image.body.length;
  for (const [oldKey, entry] of cache) {
    if (cacheBytes <= CACHE_MAX_BYTES) break;
    cache.delete(oldKey);
    cacheBytes -= entry.image.body.length;
  }
}

export function clearPublicImageCache() {
  cache.clear();
  cacheBytes = 0;
}

function requestImage(url: string, signal?: AbortSignal): Promise<ImageResponse> {
  return new Promise(resolve => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: ImageResponse) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      resolve(result);
    };
    const cancel = () => { request.destroy(); finish({ status: 0, location: null, image: null }); };
    if (signal?.aborted) { finish({ status: 0, location: null, image: null }); return; }
    const request = get(url, {
      headers: {
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': BROWSER_USER_AGENT,
      },
      // Pin every lookup to a checked public IPv4 address; no automatic redirects.
      lookup: (hostname, options, callback) => {
        void lookup(hostname, { family: 4, all: true }).then(addresses => {
          if (!addresses.length || addresses.some(a => !publicImagePageAddress(a.address))) {
            callback(new Error('Non-public image address'), '', 4); return;
          }
          if (options.all) callback(null, [addresses[0]]);
          else callback(null, addresses[0].address, 4);
        }).catch(error => callback(error, '', 4));
      },
    }, response => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        const location = typeof response.headers.location === 'string' ? response.headers.location : null;
        response.destroy(); finish({ status, location, image: null }); return;
      }
      const contentType = (response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      const responseLength = Number(response.headers['content-length'] ?? 0);
      if (status !== 200 || !ALLOWED_IMAGE_TYPES.has(contentType) || responseLength > MAX_IMAGE_BYTES) {
        response.destroy(); finish({ status, location: null, image: null }); return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_IMAGE_BYTES) { response.destroy(); finish({ status, location: null, image: null }); }
        else chunks.push(chunk);
      });
      response.on('end', () => finish({ status, location: null, image: { body: Buffer.concat(chunks), contentType } }));
      response.on('error', () => finish({ status: 0, location: null, image: null }));
    });
    request.on('error', () => finish({ status: 0, location: null, image: null }));
    timer = setTimeout(() => { request.destroy(); finish({ status: 0, location: null, image: null }); }, REQUEST_TIMEOUT_MS);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

export async function fetchPublicImage(value: string, signal?: AbortSignal): Promise<PublicImage | null> {
  let url = safeUrl(value);
  if (!url) return null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (signal?.aborted) return null;
    const response = await requestImage(url, signal);
    if (response.status >= 300 && response.status < 400 && response.location) {
      try { url = safeUrl(new URL(response.location, url).toString()); } catch { return null; }
      if (!url) return null;
      continue;
    }
    return response.image;
  }
  return null;
}

export async function getPublicImage(value: string, signal?: AbortSignal): Promise<PublicImage | null> {
  const url = safeUrl(value);
  if (!url) return null;
  const cached = readCache(url);
  if (cached) return cached;
  const image = await fetchPublicImage(url, signal);
  if (image) writeCache(url, image);
  return image;
}
