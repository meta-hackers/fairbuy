import { describe, expect, it } from 'vitest';
import { safeImageUrl } from '../src/links';

describe('product image URL checks', () => {
  it('accepts images on the source site and on a known image CDN', () => {
    expect(safeImageUrl('https://cdn.shop.fairbuy-fixture.org/aster.png', ['https://shop.fairbuy-fixture.org/aster']))
      .toBe('https://cdn.shop.fairbuy-fixture.org/aster.png');
    expect(safeImageUrl('https://store.storeimages.cdn-apple.com/1/as-images.apple.com/is/macbook.jpg', ['https://www.apple.com/it/shop/buy-mac/macbook-air']))
      .toBe('https://store.storeimages.cdn-apple.com/1/as-images.apple.com/is/macbook.jpg');
  });
  it('rejects unrelated hosts, non-HTTPS and private targets', () => {
    expect(safeImageUrl('https://unrelated.example.net/aster.png', ['https://www.apple.com/it/shop/buy-mac/macbook-air'])).toBeNull();
    expect(safeImageUrl('http://store.storeimages.cdn-apple.com/x.jpg', ['https://www.apple.com/'])).toBeNull();
    expect(safeImageUrl('https://127.0.0.1/x.jpg', ['https://www.apple.com/'])).toBeNull();
  });
});
