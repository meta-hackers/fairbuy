import { describe, expect, it } from 'vitest';
import { SOURCE_CATALOG_SEED } from '../../../data/source-catalog';
import {
  EMPTY_CONFIG, SourceEntrySchema, classifyVertical, hostInDomains, isNonSellerHost,
  isPlannedSellerHost, sourcePlan, validateSourceCatalog,
} from './index';

const brief = (category: string | null, country: string | null, purpose: string | null = null) =>
  ({ ...EMPTY_CONFIG, category, country, purpose });

describe('category-aware source hints', () => {
  it('classifies categories across languages and falls back to general', () => {
    expect(classifyVertical(brief('laptop', 'IT'))).toBe('computers');
    expect(classifyVertical(brief('PC gaming', 'IT'))).toBe('computers');
    expect(classifyVertical(brief('smartphone', 'IT'))).toBe('electronics');
    expect(classifyVertical(brief('food delivery', 'IT'))).toBe('food_delivery');
    expect(classifyVertical(brief('ristorante', 'IT'))).toBe('food_delivery');
    expect(classifyVertical(brief('Küche', 'DE'))).toBe('home');
    expect(classifyVertical(brief('scarpe', 'IT'))).toBe('fashion');
    expect(classifyVertical(brief('bicicletta', 'IT'))).toBe('sports');
    expect(classifyVertical(brief('libro', 'IT'))).toBe('books');
    expect(classifyVertical(brief('pneumatici', 'IT'))).toBe('auto');
    expect(classifyVertical(brief('food processor', 'IT'))).toBe('electronics');
    expect(classifyVertical(brief('anything at all', null))).toBe('general');
    expect(classifyVertical(brief(null, null))).toBe('general');
  });

  it('selects Swiss computer sellers and separates specification sources', () => {
    const plan = sourcePlan(brief('laptop', 'CH', 'software development'), SOURCE_CATALOG_SEED);
    const domains = plan.sellers.map(source => source.domain);
    expect(plan.vertical).toBe('computers');
    expect(domains).toEqual(expect.arrayContaining(['digitec.ch', 'galaxus.ch', 'ricardo.ch']));
    expect(domains).not.toContain('mediaworld.it');
    expect(plan.sellers.length).toBeLessThanOrEqual(8);
    expect(plan.specs.map(source => source.domain)).toContain('openicecat.com');
    expect(plan.nonSellerDomains).toEqual(expect.arrayContaining(['openicecat.com', 'notebookcheck.net', 'toppreise.ch']));
  });

  it('selects Italian sellers and comparison domains for the same category', () => {
    const plan = sourcePlan(brief('laptop', 'IT', 'software development'), SOURCE_CATALOG_SEED);
    const domains = plan.sellers.map(source => source.domain);
    expect(domains).toEqual(expect.arrayContaining(['mediaworld.it', 'unieuro.it', 'amazon.it', 'ebay.it']));
    expect(domains).not.toContain('ricardo.ch');
    expect(plan.nonSellerDomains).toEqual(expect.arrayContaining(['openicecat.com', 'idealo.it', 'trovaprezzi.it']));
  });

  it('uses food-delivery platforms for food and keeps product marketplaces out', () => {
    const plan = sourcePlan(brief('food delivery', 'IT', 'sushi for dinner'), SOURCE_CATALOG_SEED);
    const domains = plan.sellers.map(source => source.domain);
    expect(plan.vertical).toBe('food_delivery');
    expect(domains).toEqual(expect.arrayContaining(['ubereats.com', 'glovoapp.com', 'deliveroo.it', 'just-eat.it']));
    expect(domains).not.toContain('amazon.it');
    expect(plan.specs).toEqual([]);
    expect(plan.nonSellerDomains).toContain('thefork.com');
  });

  it('applies persisted overrides and hides disabled entries without losing role safety', () => {
    const disabled = SOURCE_CATALOG_SEED.map(source => source.domain === 'openicecat.com' ? { ...source, enabled: false } : source);
    const disabledPlan = sourcePlan(brief('laptop', 'CH'), disabled);
    expect(disabledPlan.specs.map(source => source.domain)).not.toContain('openicecat.com');
    expect(disabledPlan.nonSellerDomains).toContain('openicecat.com');

    const override = SourceEntrySchema.parse({
      domain: 'Example.Store', name: 'Example Store', roles: ['seller'], verticals: ['computers'],
      countries: ['CH'], priority: 3, enabled: true,
    });
    expect(override.domain).toBe('example.store');
    const plan = sourcePlan(brief('laptop', 'CH'), [...SOURCE_CATALOG_SEED, override]);
    expect(plan.sellers.map(source => source.domain)).toContain('example.store');
  });

  it('keeps the seed catalog valid and unique', () => {
    expect(new Set(SOURCE_CATALOG_SEED.map(source => source.domain)).size).toBe(SOURCE_CATALOG_SEED.length);
    expect(validateSourceCatalog(SOURCE_CATALOG_SEED)).toHaveLength(SOURCE_CATALOG_SEED.length);
    expect(() => validateSourceCatalog([SOURCE_CATALOG_SEED[0], SOURCE_CATALOG_SEED[0]])).toThrow(/Duplicate source domain/);
  });

  it('validates persisted catalog entries', () => {
    expect(() => SourceEntrySchema.parse({ domain: 'not a host', name: 'X', roles: ['seller'], verticals: ['computers'], countries: ['CH'], priority: 3 })).toThrow();
    expect(() => SourceEntrySchema.parse({ domain: 'shop.example', name: 'X', roles: [], verticals: ['computers'], countries: ['CH'], priority: 3 })).toThrow();
    expect(() => SourceEntrySchema.parse({ domain: 'shop.example', name: 'X', roles: ['seller'], verticals: ['nope'], countries: ['CH'], priority: 3 })).toThrow();
    expect(() => SourceEntrySchema.parse({ domain: 'shop.example', name: 'X', roles: ['seller'], verticals: ['computers'], countries: ['ch'], priority: 3 })).toThrow();
    expect(() => SourceEntrySchema.parse({ domain: 'shop.example', name: 'X', roles: ['seller'], verticals: ['computers'], countries: 'global', priority: 4 })).toThrow();
  });

  it('does not invent country coverage and matches subdomains only at dot boundaries', () => {
    const swissFood = sourcePlan(brief('food delivery', 'CH', null), SOURCE_CATALOG_SEED);
    expect(swissFood.sellers.map(source => source.domain)).toContain('ubereats.com');
    expect(swissFood.sellers.map(source => source.domain)).not.toContain('deliveroo.it');

    const plan = sourcePlan(brief('laptop', 'CH', null), SOURCE_CATALOG_SEED);
    expect(hostInDomains('www.digitec.ch', ['digitec.ch'])).toBe(true);
    expect(hostInDomains('notdigitec.ch', ['digitec.ch'])).toBe(false);
    expect(isNonSellerHost('https://www.openicecat.com/en/product/1', plan)).toBe(true);
    expect(isNonSellerHost('https://fakeopenicecat.com/en/product/1', plan)).toBe(false);
    expect(isPlannedSellerHost('https://www.digitec.ch/en/s1/product/1', plan)).toBe(true);
    expect(isPlannedSellerHost('https://example.com/product/1', plan)).toBe(false);
  });
});
