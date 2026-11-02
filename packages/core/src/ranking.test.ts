import { describe, expect, it } from 'vitest';
import { DemoAIProvider } from '../../../backend/src/ai/demo';
import { EMPTY_CONFIG, constraintsFor, effectiveConfig, type Constraint, type DiscoveryContext, type Offer } from './index';
import { finalPrice, rankOffers, scorePoints } from './ranking';
import { rankProducts, roundOutcome } from './shopping';

const context: DiscoveryContext = {
  sessionId: 'test', discoverySessionId: 'round-1', initialRequest: 'Laptop', initialConfig: EMPTY_CONFIG,
  config: { ...EMPTY_CONFIG, category: 'laptop', country: 'IT', purpose: 'Coding', budgetMax: 700 }, previousProducts: [], discardedProducts: [], feedback: [],
};
const offers = (await new DemoAIProvider().discover(context)).products.flatMap(p => p.offers);
const rank = (items: Offer[], hard = true) => rankOffers({ offers: items, constraints: [...constraintsFor({ ...context.config, budgetHard: hard }), { attribute: 'ramGb', op: '>=', value: 16, hard }], spec: { id: 'laptop', attributes: [{ key: 'ramGb', unit: 'GB' }] }, currency: 'EUR' });
describe('deterministic ranking inherited from Alessandro', () => {
  it('excludes failed hard constraints before scoring', () => {
    const result = rank(offers);
    expect(result.excluded).toHaveLength(4);
    expect(result.ranked.every(r => r.price.cents !== null && r.price.cents <= 70000)).toBe(true);
  });
  it('keeps soft mismatches as trade-offs', () => { expect(rank(offers, false).ranked).toHaveLength(offers.length); });
  it('is independent of input order', () => { expect(rank([...offers].reverse()).ranked).toEqual(rank(offers).ranked); });
  it('never treats an unlisted final price as zero or passes an unknown budget', () => {
    const unknown = structuredClone(offers[0]);
    unknown.price.amountCents = null;
    expect(finalPrice(unknown.price)).toEqual({ cents: null, known: false });
    const candidate = rank([unknown]).ranked[0];
    expect(candidate.status).toBe('unverified');
    expect(candidate.breakdown.cost).toBe(0);
    expect(candidate.constraints.find(c => c.constraint.attribute === 'total')?.outcome).toBe('unknown');
  });
  it('does not compare different currencies or numeric units', () => {
    const currency = structuredClone(offers[0]); currency.price.currency = 'CHF';
    expect(rank([currency]).excluded[0].reasons[0]).toContain('Different currency');
    const units = structuredClone(offers[0]);
    const ram = units.attributes.ramGb;
    if (ram.status !== 'unknown' && ram.value.kind === 'number') ram.value.unit = 'MB';
    expect(rank([units]).ranked[0].status).toBe('unverified');
  });
  it('keeps uninterpreted must-haves unknown rather than silently passing', () => {
    const config = { ...context.config, requirements: [{ label: 'Works with my setup', hard: true, attribute: null, value: null, unit: null, op: null }] };
    const result = rankOffers({ offers: [offers[0]], constraints: constraintsFor(config), spec: { id: 'laptop', attributes: [] }, currency: 'EUR' });
    expect(result.ranked[0].status).toBe('unverified');
  });
  it('normalizes a major-unit price floor to the total pseudo-attribute', () => {
    const config = { ...context.config, requirements: [
      { label: 'Price above 10k CHF', hard: true, attribute: 'price', op: '>=' as const, value: 10000, unit: 'CHF' },
    ] };
    expect(constraintsFor(config)).toContainEqual({ attribute: 'total', op: '>=', value: 1000000, hard: true });
    const result = rankOffers({ offers: [offers[0]], constraints: constraintsFor(config), spec: { id: 'laptop', attributes: [] }, currency: 'EUR' });
    expect(result.excluded[0].reasons.join(' ')).toContain('Final listed price');
  });
  it('matches common seller wording for hard enum constraints', () => {
    const watch = structuredClone(offers[0]);
    watch.attributes.caseMaterial = { status: 'seller_claim', value: { kind: 'text', value: 'Stainless steel' }, evidence: watch.evidence };
    watch.attributes.origin = { status: 'seller_claim', value: { kind: 'text', value: 'Made in Switzerland' }, evidence: watch.evidence };
    watch.attributes.complication = { status: 'seller_claim', value: { kind: 'text', value: 'moon-phase indicator' }, evidence: watch.evidence };
    const config = { ...context.config, requirements: [
      { label: 'Steel case', hard: true, attribute: 'caseMaterial', op: '=' as const, value: 'steel', unit: null },
      { label: 'Swiss made', hard: true, attribute: 'origin', op: '=' as const, value: 'Swiss made', unit: null },
      { label: 'Moonphase', hard: true, attribute: 'complication', op: '=' as const, value: 'moonphase', unit: null },
    ] };
    const result = rankOffers({ offers: [watch], constraints: constraintsFor(config), spec: { id: 'watch', attributes: [] }, currency: 'EUR' });
    expect(result.ranked).toHaveLength(1);
    expect(result.ranked[0].constraints.every(c => c.outcome === 'pass')).toBe(true);
  });
  it('excludes an explicitly named brand while leaving other brands eligible', () => {
    const config = { ...context.config, requirements: [
      { label: 'Avoid Rolex', hard: true, attribute: 'brandExcluded', op: '=' as const, value: 'not Rolex', unit: null },
    ] };
    const excluded = structuredClone(offers[0]); excluded.title = 'Rolex Submariner'; excluded.seller = 'Rolex';
    const allowed = structuredClone(offers[0]); allowed.title = 'IWC Portofino';
    const spec = { id: 'laptop', attributes: [] };
    expect(rankOffers({ offers: [excluded], constraints: constraintsFor(config), spec, currency: 'EUR' }).excluded[0].reasons.join(' ')).toContain('Rolex is excluded');
    expect(rankOffers({ offers: [allowed], constraints: constraintsFor(config), spec, currency: 'EUR' }).ranked).toHaveLength(1);
    // Ask has also emitted brand="Exclude Rolex" instead of brandExcluded.
    const legacy = { ...config, requirements: [{ label: 'Avoid Rolex', hard: true, attribute: 'brand', op: '=' as const, value: 'Exclude Rolex', unit: null }] };
    expect(rankOffers({ offers: [excluded], constraints: constraintsFor(legacy), spec, currency: 'EUR' }).excluded[0].reasons.join(' ')).toContain('Rolex is excluded');
  });
  it('applies explicit Learn refinements without mutating the original configuration', () => {
    const refined = structuredClone(context);
    refined.config.requirements = [{ label: '16 GB', hard: true, attribute: 'ramGb', op: '>=', value: 16, unit: 'GB' }];
    refined.feedback = [{ id: 'f1', productId: null, productName: null, reason: 'Actually 8 GB and EUR 900 are okay', at: new Date().toISOString(), learned: [
      { label: '8 GB is enough', hard: false, attribute: 'ramGb', op: '>=', value: 8, unit: 'GB' },
      { label: 'Budget EUR 900', hard: true, attribute: 'total', op: '<=', value: 90000, unit: 'cents' },
    ] }];
    const result = effectiveConfig(refined);
    expect(result.requirements).toHaveLength(1); expect(result.requirements[0].value).toBe(8);
    expect(result.budgetMax).toBe(900); expect(result.budgetHard).toBe(true);
    expect(refined.config.requirements[0].value).toBe(16); expect(refined.config.budgetMax).toBe(700);
  });
});

describe('score calibration (ranking 3.0.0)', () => {
  const spec = { id: 'laptop', attributes: [{ key: 'ramGb', unit: 'GB' }] };
  const offer = (id: string, cents: number | null) => {
    const o = structuredClone(offers[0]); o.id = id; o.price.amountCents = cents; return o;
  };
  const score = (items: Offer[], constraints: Constraint[] = []) => rankOffers({ offers: items, constraints, spec, currency: 'EUR' });
  const byId = (result: ReturnType<typeof score>, id: string) => result.ranked.find(r => r.offerId === id)!;
  const ram16: Constraint = { attribute: 'ramGb', op: '>=', value: 16, hard: false };
  const coding: Constraint = { attribute: 'uninterpreted_0', op: '=', value: 'Good for coding', hard: false };

  it('keeps a small price gap small instead of zeroing the dearer offer', () => {
    const result = score([offer('a', 50000), offer('b', 51000)]);
    expect(byId(result, 'a').breakdown.cost).toBe(0.6);
    expect(byId(result, 'b').breakdown.cost).toBeCloseTo(0.6 * 50000 / 51000, 4);
  });

  it('scores checkable preferences on their full share', () => {
    const top = score([offer('a', 50000)], [ram16]).ranked[0];
    expect(top.weights).toEqual({ cost: 0.3, suitability: 0.5, reliability: 0.2 });
    expect(top.breakdown.suitability).toBe(0.5);
    expect(top.score).toBeCloseTo(0.3 + 0.5 + 0.2 * 0.9, 4);
  });

  it('redistributes the preference share when no preference can be checked', () => {
    const none = score([offer('a', 50000)]);
    const unchecked = score([offer('a', 50000)], [coding]);
    expect(none.ranked[0].weights).toEqual({ cost: 0.6, suitability: 0, reliability: 0.4 });
    expect(none.ranked[0].score).toBeCloseTo(0.6 + 0.4 * 0.9, 4);
    expect(unchecked.ranked[0].score).toBe(none.ranked[0].score);
    expect(unchecked.ranked[0].constraints[0].outcome).toBe('unknown');
    expect(unchecked.warnings).toContain('1 preference cannot be checked automatically and does not affect scores.');
  });

  it('still counts an unknown checkable preference as unmatched', () => {
    const unknown = offer('a', 50000);
    unknown.attributes = {};
    expect(score([unknown], [ram16]).ranked[0].breakdown.suitability).toBe(0);
  });

  it('does not let optional unknown details lower evidence', () => {
    const sparse = offer('a', 50000); sparse.missing = [];
    const detailed = offer('b', 50000); detailed.missing = ['Battery health', 'Warranty', 'Weight', 'Ports'];
    const result = score([sparse, detailed], [ram16]);
    expect(byId(result, 'b').breakdown.reliability).toBe(byId(result, 'a').breakdown.reliability);
  });

  it('splits the displayed score into whole parts that add up', () => {
    for (const ranked of rank(offers, false).ranked) {
      const points = scorePoints(ranked);
      expect(points.cost + points.suitability + points.reliability).toBe(points.total);
      expect(points.total).toBe(Math.round(ranked.score * 100));
    }
    expect(scorePoints({ score: 0.6667, breakdown: { cost: 0.2222, suitability: 0.2222, reliability: 0.2223 } }))
      .toEqual({ cost: 22, suitability: 22, reliability: 23, total: 67 });
  });
});

describe('shopping country (issue #27)', () => {
  // A Chilean brief priced in EUR, as in the OLED session: currency alone does not stop EU sellers.
  const chile = { ...context, config: { ...context.config, country: 'CL', city: 'Santiago', currency: 'EUR' as const } };
  const live = (id: string, url: string, sellerMarket?: Offer['sellerMarket']) => {
    const o = structuredClone(offers[0]); o.id = id; o.mode = 'live'; o.provenanceUrl = url;
    if (sellerMarket) o.sellerMarket = sellerMarket; else delete o.sellerMarket;
    return o;
  };
  const products = (items: Offer[]) => items.map(o => ({ id: o.id, name: o.id, summary: '', why: '', tradeoffs: [], imageUrl: null, offers: [o] }));

  it('excludes a seller known to sell elsewhere even when the currency matches', () => {
    const result = rankProducts(products([
      live('galaxus', 'https://www.galaxus.de/p/1', { countries: ['DE'], basis: 'domain' }),
      live('amazon', 'https://www.amazon.de/dp/1', { countries: ['DE', 'AT'], basis: 'source_catalog' }),
    ]), chile);
    expect(result.ranked).toEqual([]);
    expect(result.excluded.find(e => e.offerId === 'galaxus')?.reasons).toContain('Seller serves DE, not CL (from its .de domain)');
    expect(result.excluded.find(e => e.offerId === 'amazon')?.reasons).toContain('Seller serves DE, AT, not CL (per the source catalog)');
  });

  it('keeps local and global sellers, and an unidentified market as an open check', () => {
    const result = rankProducts(products([
      live('local', 'https://www.falabella.com/p/1', { countries: ['CL'], basis: 'source_catalog' }),
      live('global', 'https://www.etsy.com/listing/1', { countries: 'global', basis: 'source_catalog' }),
      live('unknown', 'https://www.ldlc.com/p/1'),
    ]), chile);
    const byId = (id: string) => result.ranked.find(r => r.offerId === id)!;
    expect(result.ranked).toHaveLength(3);
    expect(byId('local').constraints.at(-1)).toMatchObject({ outcome: 'pass', reason: 'Seller serves CL (per the source catalog)' });
    expect(byId('global').constraints.at(-1)?.outcome).toBe('pass');
    expect(byId('unknown').constraints.at(-1)).toMatchObject({ outcome: 'unknown', reason: 'Delivery to CL is not verified' });
    expect(byId('unknown').status).toBe('unverified');
  });

  it('flags a currency that is not the local one', () => {
    expect(rankProducts([], chile).warnings[0]).toBe('Prices must be in EUR, but sellers in CL usually list in CLP. Switch the currency to CLP to compare local offers.');
    expect(rankProducts([], context).warnings.join(' ')).not.toContain('Switch the currency');
  });

  it('does not check synthetic fixtures or briefs without a country', () => {
    expect(rankProducts(products([offers[0]]), chile).ranked[0].constraints.some(c => c.constraint.attribute === 'sellerMarket')).toBe(false);
    const noCountry = { ...context, config: { ...context.config, country: null } };
    expect(rankProducts(products([live('x', 'https://www.galaxus.de/p/1', { countries: ['DE'], basis: 'domain' })]), noCountry).ranked).toHaveLength(1);
  });
});

describe('round outcome (issue #19)', () => {
  const ranking = (ranked: number) => ({ rankingVersion: 'x', ranked: Array.from({ length: ranked }, () => ({}) as never), excluded: [], warnings: [] });
  const source = { url: 'https://shop.example.org/p', title: 'p' };
  it('separates not found from found but rejected', () => {
    expect(roundOutcome({ products: [], sources: [], ranking: null })).toBe('nothing_retrieved');
    expect(roundOutcome({ products: [], sources: [source], ranking: ranking(0) })).toBe('nothing_grounded');
    expect(roundOutcome({ products: [{} as never], sources: [source], ranking: ranking(0) })).toBe('all_excluded');
    expect(roundOutcome({ products: [{} as never], sources: [source], ranking: ranking(1) })).toBe('found');
  });
});
