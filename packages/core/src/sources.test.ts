import { describe, expect, it } from 'vitest';
import { SOURCE_CATALOG_SEED } from '../../../data/source-catalog';
import {
  EMPTY_CONFIG, SourceCatalogValidationError, SourceEntrySchema, classifyVertical, hostInDomains,
  isNonSellerHost, isPlannedSellerHost, sellerMarketFor, sellerMarkets, sourcePlan, validateSourceCatalog,
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
    expect(classifyVertical(brief('watch', 'CH'))).toBe('watches');
    expect(classifyVertical(brief('orologio', 'IT'))).toBe('watches');
    expect(classifyVertical(brief('montre', 'FR'))).toBe('watches');
    expect(classifyVertical(brief('smartwatch', 'IT'))).toBe('electronics');
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

  it('plans watch sources for the watches vertical', () => {
    const watchCatalog = [SourceEntrySchema.parse({
      domain: 'rolex.com', name: 'Rolex', roles: ['spec'], verticals: ['watches'], countries: 'global', priority: 3,
    }), SourceEntrySchema.parse({
      domain: 'chrono24.com', name: 'Chrono24', roles: ['marketplace'], verticals: ['watches'], countries: 'global', priority: 3,
    })];
    const plan = sourcePlan(brief('watch', 'CH'), watchCatalog);
    expect(plan.vertical).toBe('watches');
    expect(plan.sellers.map(source => source.domain)).toContain('chrono24.com');
    expect(plan.specs.map(source => source.domain)).toContain('rolex.com');
    expect(plan.nonSellerDomains).toContain('rolex.com');
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
    expect(() => validateSourceCatalog([SOURCE_CATALOG_SEED[0], SOURCE_CATALOG_SEED[0]])).toThrow(SourceCatalogValidationError);
  });

  it('reports entry-level validation issues with index and domain', () => {
    let error: unknown;
    try { validateSourceCatalog([{ ...SOURCE_CATALOG_SEED[0], verticals: ['not-a-vertical'] }]); }
    catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(SourceCatalogValidationError);
    const issues = (error as SourceCatalogValidationError).issues;
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ index: 0, domain: SOURCE_CATALOG_SEED[0].domain, path: 'verticals.0' }),
    ]));

    let duplicate: unknown;
    try { validateSourceCatalog([SOURCE_CATALOG_SEED[0], SOURCE_CATALOG_SEED[0]]); }
    catch (caught) { duplicate = caught; }
    expect((duplicate as SourceCatalogValidationError).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ index: 1, code: 'duplicate_domain' }),
    ]));
  });

  it('validates persisted catalog entries', () => {
    expect(() => SourceEntrySchema.parse({ domain: 'not a host', name: 'X', roles: ['seller'], verticals: ['computers'], countries: ['CH'], priority: 3 })).toThrow();
    expect(() => SourceEntrySchema.parse({ domain: 'shop.example', name: 'X', roles: [], verticals: ['computers'], countries: ['CH'], priority: 3 })).toThrow();
    expect(() => SourceEntrySchema.parse({ domain: 'shop.example', name: 'X', roles: ['seller'], verticals: ['Not A Vertical'], countries: ['CH'], priority: 3 })).toThrow();
    expect(() => SourceEntrySchema.parse({ domain: 'shop.example', name: 'X', roles: ['seller'], verticals: ['computers'], countries: ['ch'], priority: 3 })).toThrow();
    expect(() => SourceEntrySchema.parse({ domain: 'shop.example', name: 'X', roles: ['seller'], verticals: ['computers'], countries: 'global', priority: 4 })).toThrow();
    expect(SourceEntrySchema.parse({ domain: 'shop.example', name: 'X', roles: ['seller'], verticals: ['watches'], countries: ['CH'], priority: 3 }).verticals).toEqual(['watches']);
    expect(SourceEntrySchema.parse({ domain: 'shop.example', name: 'X', roles: ['seller'], verticals: ['new_vertical'], countries: ['CH'], priority: 3 }).verticals).toEqual(['new_vertical']);
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

describe('seller markets', () => {
  const markets = sellerMarkets(SOURCE_CATALOG_SEED);
  it('takes the countries a catalog seller serves, including other verticals', () => {
    expect(sellerMarketFor('https://www.amazon.de/dp/1', markets)).toEqual({ countries: ['DE', 'AT'], basis: 'source_catalog' });
    expect(sellerMarketFor('https://www.digitec.ch/en/s1/product/1', markets)).toEqual({ countries: ['CH'], basis: 'source_catalog' });
    expect(sellerMarketFor('https://www.etsy.com/listing/1', markets)).toEqual({ countries: 'global', basis: 'source_catalog' });
  });
  it('falls back to the country-code domain', () => {
    expect(sellerMarketFor('https://www.galaxus.de/p/1', {})).toEqual({ countries: ['DE'], basis: 'domain' });
    expect(sellerMarketFor('https://smartech.ee/p/1', {})).toEqual({ countries: ['EE'], basis: 'domain' });
    expect(sellerMarketFor('https://shop.example.co.uk/p/1', {})).toEqual({ countries: ['GB'], basis: 'domain' });
  });
  it('says nothing for generic domains', () => {
    for (const url of ['https://www.ldlc.com/p', 'https://standesk.eu/p', 'https://computeruniverse.net/p', 'https://shop.io/p', 'https://brand.co/p', 'https://www.openicecat.com/p', 'not a url']) {
      expect(sellerMarketFor(url, {})).toBeNull();
    }
  });
});

describe('electronics accessories (issue #40)', () => {
  it('classifies batteries, chargers and action cams as electronics, not general', () => {
    expect(classifyVertical(brief('GoPro batteries', 'CL', 'Batteria di ricambio per GoPro Hero 9 Black'))).toBe('electronics');
    expect(classifyVertical(brief('cargador', 'CL'))).toBe('electronics');
    expect(classifyVertical(brief('action cam', 'IT'))).toBe('electronics');
  });
  it('plans electronics retailers instead of supermarkets for a Chilean battery search', () => {
    const catalog = validateSourceCatalog([
      { domain: 'pcfactory.cl', name: 'PC Factory', roles: ['seller'], verticals: ['computers', 'electronics'], countries: ['CL'], priority: 3 },
      { domain: 'jumbo.cl', name: 'Jumbo', roles: ['seller'], verticals: ['groceries', 'general'], countries: ['CL'], priority: 3 },
    ]);
    expect(sourcePlan(brief('GoPro batteries', 'CL'), catalog).sellers.map(s => s.domain)).toEqual(['pcfactory.cl']);
  });
});

