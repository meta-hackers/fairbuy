import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import illustrations from '../../packages/core/src/product-illustrations.json';
import { productIllustration } from '../../frontend/src/productIllustrations';

describe('offline product illustrations', () => {
  it('has 300 unique product types with generated assets and provenance', () => {
    expect(illustrations).toHaveLength(300);
    expect(new Set(illustrations.map(([slug]) => slug)).size).toBe(300);
    const root = new URL('../../frontend/public/illustrations/', import.meta.url);
    const provenance = JSON.parse(readFileSync(new URL('provenance.json', root), 'utf8'));
    for (const [index, [slug, subject]] of illustrations.entries()) {
      expect(existsSync(new URL(`${slug}.webp`, root)), slug).toBe(true);
      expect(provenance[slug]?.provider, slug).toBe(index < 150 ? 'cloudflare' : 'meta');
      expect(provenance[slug]?.model, slug).toBe(index < 150 ? '@cf/black-forest-labs/flux-1-schnell' : 'muse-image-1.0');
      expect(provenance[slug]?.prompt, slug).toContain(subject);
      const bytes = readFileSync(new URL(`${slug}.webp`, root));
      expect(bytes.subarray(0, 4).toString(), slug).toBe('RIFF');
      expect(bytes.subarray(8, 12).toString(), slug).toBe('WEBP');
      expect(createHash('sha256').update(bytes).digest('hex'), slug).toBe(provenance[slug]?.sha256);
    }
  });
  it('maps every declared alias back to its product type', () => {
    for (const [slug, , words] of illustrations) {
      for (const word of words.split('|')) {
        expect(productIllustration(word), word).toBe(`/illustrations/${slug}.webp`);
      }
    }
  });
  it('uses only valid model artwork IDs and never overrides deterministic aliases', () => {
    expect(productIllustration('Relojes', 'Speedmaster', 'watch')).toBe('/illustrations/watch.webp');
    expect(productIllustration('Relojes', 'Speedmaster', '../private')).toBe('/illustrations/generic.webp');
    expect(productIllustration('Relojes', 'Speedmaster', 'https://evil.test/image')).toBe('/illustrations/generic.webp');
    expect(productIllustration('laptop', 'ThinkPad', 'watch')).toBe('/illustrations/laptop.webp');
  });
  it.each([
    ['cars', 'Used car', 'car'],
    ['wrist watches', 'Omega Speedmaster', 'watch'],
    ['wristwatches', 'Seiko Presage', 'watch'],
    ['watches', 'Tissot PRX', 'watch'],
    ['wrist-watch', 'Citizen Tsuyosa', 'watch'],
    ['orologi', '', 'watch'],
    ['smartwatches', '', 'smartwatch'],
    ['auto', 'VW Golf', 'car'],
    ['electronics', 'Lenovo ThinkPad', 'laptop'],
    ['bicycle', 'Electric bike', 'electric-bike'],
    ['appliances', 'Robot vacuum', 'robot-vacuum'],
    ['fashion', 'T-shirt', 't-shirt'],
    ['lavatrice', '', 'washing-machine'],
    ['Wäschetrockner', '', 'dryer'],
    ['camera', 'Camera lens', 'camera-lens'],
    ['electronics', 'Graphics card', 'graphics-card'],
    ['unknown', 'Unidentified object', 'generic'],
    ['fashion', 'Earrings', 'earrings'],
    ['electronics', '3D printer', '3d-printer'],
    ['stationery', 'Paper notebook', 'paper-notebook'],
    ['smart home', 'Security camera', 'security-camera'],
    ['kitchen', 'Pressure cooker', 'pressure-cooker'],
    ['sports', 'Badminton racket', 'badminton-racket'],
    ['pets', 'Cat tree', 'cat-tree'],
    ['werkzeuge', 'Winkelschleifer', 'angle-grinder'],
    ['kitchen', 'Borraccia', 'water-bottle'],
  ])('matches %s / %s to %s', (category, name, slug) => {
    expect(productIllustration(category, name)).toBe(`/illustrations/${slug}.webp`);
  });
});
