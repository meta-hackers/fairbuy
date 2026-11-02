import { describe, expect, it } from 'vitest';
import { fetchPublicImage, getPublicImage } from '../src/image-proxy';

describe('public image proxy', () => {
  it('rejects unsafe targets before any network request', async () => {
    for (const url of [
      'http://images.seller.org/x.jpg',
      'https://127.0.0.1/x.jpg',
      'https://localhost/x.jpg',
      'https://user:pass@images.seller.org/x.jpg',
      'data:image/png;base64,123',
    ]) {
      expect(await fetchPublicImage(url)).toBeNull();
      expect(await getPublicImage(url)).toBeNull();
    }
  });
});
