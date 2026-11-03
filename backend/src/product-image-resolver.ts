import type { Product } from '@fairbuy/core';
import { findSellerImage } from './product-images';
import { getPublicImage, type PublicImage } from './image-proxy';
import { logger } from './logger';

// Cache selections, not another copy of the bytes. Include sources in the key so
// a later search with a new seller can recover immediately after an earlier miss.
export class ProductImageResolver {
  private selections = new Map<string, { url: string | null; expiresAt: number }>();
  private pending = new Map<string, Promise<PublicImage | null>>();

  async get(product: Product): Promise<PublicImage | null> {
    const key = JSON.stringify([product.id, product.imageUrl, product.offers.map(o => [o.mode, o.provenanceUrl])]);
    if (this.pending.has(key)) return this.pending.get(key)!;
    // Bound concurrent recovery work as well as completed cache entries.
    if (this.pending.size >= 32) return null;
    const pending = this.resolve(key, product);
    this.pending.set(key, pending);
    try { return await pending; }
    finally { this.pending.delete(key); }
  }

  private async resolve(key: string, product: Product): Promise<PublicImage | null> {
    const signal = AbortSignal.timeout(20000);
    const cached = this.selections.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      if (!cached.url) return null;
      const image = await getPublicImage(cached.url, signal, product.offers[0]?.provenanceUrl);
      if (image) return image;
    }
    const started = Date.now();
    const url = await findSellerImage(product, product.imageUrl, signal);
    this.selections.delete(key);
    this.selections.set(key, { url, expiresAt: Date.now() + (url ? 3600000 : 60000) });
    while (this.selections.size > 512) this.selections.delete(this.selections.keys().next().value!);
    logger.info('image.product.resolved', {
      productId: product.id, available: !!url, offers: product.offers.length, durationMs: Date.now() - started,
    });
    return url ? getPublicImage(url, signal, product.offers[0]?.provenanceUrl) : null;
  }
}
