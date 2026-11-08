import catalog from './product-illustrations.json';

export const ILLUSTRATIONS = catalog;
const slugs = new Set(catalog.map(([slug]) => slug));
export const isIllustrationSlug = (value: unknown): value is string => typeof value === 'string' && slugs.has(value);
// Whole words avoid matching "car" in "card". Longer aliases win.
const normalize = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const aliases = catalog.filter(([slug]) => slug !== 'generic').flatMap(([slug, , words]) =>
  words.split('|').map(word => ({ slug, word: normalize(word) }))).sort((a, b) => b.word.length - a.word.length);

export function illustrationSlug(category: string, name = '') {
  const text = ` ${normalize(`${category} ${name}`)} `;
  return aliases.find(({ word }) => text.includes(` ${word} `))?.slug ?? 'generic';
}
