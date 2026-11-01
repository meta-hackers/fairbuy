import { describe, expect, it } from 'vitest';
import { publicImagePageAddress, sellerImage } from '../src/product-images';

const page = 'https://shop.fairbuy-fixture.org/products/laptop';
describe('seller product images', () => {
  it('extracts seller metadata, including images served by an external CDN', () => {
    expect(sellerImage('<meta content="https://images.seller-cdn.org/laptop.jpg?w=800&amp;h=600" property="og:image">', page))
      .toBe('https://images.seller-cdn.org/laptop.jpg?w=800&h=600');
    expect(sellerImage("<meta name='twitter:image' content='/images/laptop.jpg'>", page))
      .toBe('https://shop.fairbuy-fixture.org/images/laptop.jpg');
  });
  it('extracts Product JSON-LD images without using unrelated page images', () => {
    const html = `<script type="application/ld+json">${JSON.stringify({ '@graph': [
      { '@type': 'Organization', image: '/logo.png' },
      { '@type': ['Product'], image: [{ url: '/laptop.png' }] },
    ] })}</script>`;
    expect(sellerImage(html, page)).toBe('https://shop.fairbuy-fixture.org/laptop.png');
    expect(sellerImage('<img src="/unrelated.png">', page)).toBeNull();
  });
  it('ignores invalid metadata and unsafe image URLs', () => {
    expect(sellerImage('<script type="application/ld+json">invalid</script>', page)).toBeNull();
    for (const url of ['http://cdn.seller.org/image.jpg', 'https://127.0.0.1/image', 'data:image/png;base64,123', 'https://user:pass@seller.org/image']) {
      expect(sellerImage(`<meta property="og:image" content="${url}">`, page)).toBeNull();
    }
  });
  it('rejects private, loopback, metadata, reserved and non-IPv4 destinations', () => {
    for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '198.18.0.1', '::1', '::ffff:127.0.0.1']) {
      expect(publicImagePageAddress(address)).toBe(false);
    }
    expect(publicImagePageAddress('8.8.8.8')).toBe(true);
  });
});
