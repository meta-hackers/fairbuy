import illustrations from './product-illustrations.json';

// Whole-word matching avoids "car" in "card" and "ring" in "earrings".
// Longer aliases win so "electric bike" does not become a generic bicycle.
const normalize = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const aliases = illustrations.filter(([slug]) => slug !== 'generic').flatMap(([slug, , words]) =>
  words.split('|').map(word => ({ slug, word: normalize(word) })))
  .sort((a, b) => b.word.length - a.word.length);

export function productIllustration(category: string, name = '') {
  const text = ` ${normalize(`${category} ${name}`)} `;
  const slug = aliases.find(({ word }) => text.includes(` ${word} `))?.slug ?? 'generic';
  return `/illustrations/${slug}.webp`;
}
