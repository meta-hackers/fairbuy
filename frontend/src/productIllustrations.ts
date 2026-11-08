import { illustrationSlug, isIllustrationSlug } from '@fairbuy/core';

export function productIllustration(category: string, name = '', selected?: string) {
  const matched = illustrationSlug(category, name);
  const slug = matched === 'generic' && isIllustrationSlug(selected) ? selected : matched;
  return `/illustrations/${slug}.webp`;
}
