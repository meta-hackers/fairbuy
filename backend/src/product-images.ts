import { lookup } from 'node:dns/promises';
import { get } from 'node:https';
import type { Product } from '@fairbuy/core';
import { safeUrl } from './links';

// Only public IPv4 destinations are used, pinned to the checked DNS answer.
export function publicImagePageAddress(address: string) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = octets;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0));
}

async function readPage(value: string): Promise<{ html: string; url: string } | null> {
  const url = safeUrl(value);
  if (!url) return null;
  return new Promise(resolve => {
    const timer = setTimeout(() => { request.destroy(); resolve(null); }, 4000);
    const finish = (result: { html: string; url: string } | null) => { clearTimeout(timer); resolve(result); };
    const request = get(url, {
      headers: { Accept: 'text/html', 'User-Agent': 'FairBuy/1.0 (product image preview)' },
      // No redirects: a seller cannot redirect this fetch into a private network.
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
      if (response.statusCode !== 200 || !response.headers['content-type']?.includes('text/html')) {
        response.destroy(); finish(null); return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1024 * 1024) { response.destroy(); finish(null); }
        else chunks.push(chunk);
      });
      response.on('end', () => finish({ html: Buffer.concat(chunks).toString('utf8'), url }));
      response.on('error', () => finish(null));
    });
    request.on('error', () => finish(null));
  });
}

function decode(value: string) {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, entity => {
    const named: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const number = entity[2].toLowerCase() === 'x' ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
  });
}

/** Metadata is grounded in the seller HTML; external image CDNs are allowed. */
export function sellerImage(html: string, pageUrl: string): string | null {
  const candidates: string[] = [];
  const meta = new Map<string, string>();
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attributes = new Map([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)]
      .map(match => [match[1].toLowerCase(), decode(match[2] ?? match[3] ?? match[4])]));
    const key = attributes.get('property') ?? attributes.get('name');
    if (key && attributes.get('content')) meta.set(key.toLowerCase(), attributes.get('content')!);
  }
  for (const key of ['og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src']) {
    if (meta.has(key)) candidates.push(meta.get(key)!);
  }
  function productImages(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(productImages); return; }
    const object = value as Record<string, unknown>;
    const types = Array.isArray(object['@type']) ? object['@type'] : [object['@type']];
    if (types.includes('Product')) {
      for (const image of Array.isArray(object.image) ? object.image : [object.image]) {
        const url = typeof image === 'string' ? image : image && typeof image === 'object' ? (image as Record<string, unknown>).url : null;
        if (typeof url === 'string') candidates.push(url);
      }
    }
    if (object['@graph']) productImages(object['@graph']);
  }
  for (const script of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    try { productImages(JSON.parse(script[1])); } catch { /* Invalid seller metadata is optional. */ }
  }
  for (const candidate of candidates) {
    try {
      const image = safeUrl(new URL(candidate, pageUrl).toString());
      if (image && image.length <= 2000) return image;
    } catch { /* Try the next metadata image. */ }
  }
  return null;
}

export async function findSellerImage(product: Product): Promise<string | null> {
  // One bounded request per product; never fetch arbitrary model-generated image URLs.
  const source = product.offers[0]?.provenanceUrl;
  if (!source) return null;
  try {
    const page = await readPage(source);
    return page ? sellerImage(page.html, page.url) : null;
  } catch { return null; }
}
