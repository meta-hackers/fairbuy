import { describe, expect, it } from 'vitest';
import { DemoAIProvider } from '../../../backend/src/ai/demo';
import { EMPTY_CONFIG, constraintsFor, effectiveConfig, type DiscoveryContext, type Offer } from './index';
import { finalPrice, rankOffers } from './ranking';

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
