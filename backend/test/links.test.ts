import { describe, expect, it } from 'vitest';
import { safeImageUrl } from '../src/links';

describe('product image URL checks', () => {
  it('accepts images on the source site and on a known image CDN', () => {
    expect(safeImageUrl('https://cdn.shop.fairbuy-fixture.org/aster.png', ['https://shop.fairbuy-fixture.org/aster']))
      .toBe('https://cdn.shop.fairbuy-fixture.org/aster.png');
    expect(safeImageUrl('https://store.storeimages.cdn-apple.com/1/as-images.apple.com/is/macbook.jpg', ['https://www.apple.com/it/shop/buy-mac/macbook-air']))
      .toBe('https://store.storeimages.cdn-apple.com/1/as-images.apple.com/is/macbook.jpg');
    // Galaxus and Digitec share an image CDN on a different registrable domain.
    expect(safeImageUrl('https://static01.galaxus.com/productimages/a/aster.jpeg', ['https://www.galaxus.ch/en/s1/product/aster']))
      .toBe('https://static01.galaxus.com/productimages/a/aster.jpeg');
    expect(safeImageUrl('https://static01.galaxus.com/productimages/a/aster.jpeg', ['https://www.digitec.ch/en/s1/product/aster']))
      .toBe('https://static01.galaxus.com/productimages/a/aster.jpeg');
    // Search-result thumbnails are proxied by Brave and remain reachable when a seller page is blocked.
    expect(safeImageUrl('https://imgs.search.brave.com/abc/rs:fit:200:200:1:0/x', ['https://www.autoscout24.ch/de/d/aster']))
      .toBe('https://imgs.search.brave.com/abc/rs:fit:200:200:1:0/x');
  });
  it('rejects unrelated hosts, non-HTTPS and private targets', () => {
    expect(safeImageUrl('https://unrelated.example.net/aster.png', ['https://www.apple.com/it/shop/buy-mac/macbook-air'])).toBeNull();
    expect(safeImageUrl('http://store.storeimages.cdn-apple.com/x.jpg', ['https://www.apple.com/'])).toBeNull();
    expect(safeImageUrl('https://127.0.0.1/x.jpg', ['https://www.apple.com/'])).toBeNull();
  });
});
