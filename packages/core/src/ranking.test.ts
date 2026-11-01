import { describe, expect, it } from 'vitest';
import { DemoAIProvider } from '../../../backend/src/ai/demo';
import { EMPTY_CONFIG, constraintsFor, effectiveConfig, type DiscoveryContext, type Offer } from './index';
import { computeTotal, rankOffers } from './ranking';

const context: DiscoveryContext = {
  sessionId: 'test', discoverySessionId: 'round-1', initialRequest: 'Laptop', initialConfig: EMPTY_CONFIG,
  config: { ...EMPTY_CONFIG, category: 'laptop', country: 'IT', purpose: 'Coding', budgetMax: 700 }, previousProducts: [], discardedProducts: [], feedback: [],
};
const offers = (await new DemoAIProvider().discover(context)).products.flatMap(p => p.offers);
const rank = (items: Offer[], hard = true) => rankOffers({ offers: items, constraints: [...constraintsFor({ ...context.config, budgetHard: hard }), { attribute: 'ramGb', op: '>=', value: 16, hard }], spec: { id: 'laptop', attributes: [{ key: 'ramGb', unit: 'GB' }] }, currency: 'EUR' });
describe('deterministic ranking inherited from Alessandro', () => {
  it('excludes failed hard constraints before scoring', () => {
    const result = rank(offers);
    expect(result.excluded).toHaveLength(5);
    expect(result.ranked.every(r => r.total.cents <= 70000)).toBe(true);
  });
  it('keeps soft mismatches as trade-offs', () => { expect(rank(offers, false).ranked).toHaveLength(offers.length); });
  it('is independent of input order', () => { expect(rank([...offers].reverse()).ranked).toEqual(rank(offers).ranked); });
  it('never treats unknown charges as zero or passes an incomplete budget', () => {
    const incomplete = structuredClone(offers[0]);
    incomplete.price.components[1] = { kind: 'shipping', amountCents: 99999, status: 'unknown' };
    incomplete.price.totalIsLowerBound = true;
    expect(computeTotal(incomplete.price)).toEqual({ cents: 59000, isLowerBound: true });
    const candidate = rank([incomplete]).ranked[0];
    expect(candidate.status).toBe('unverified');
    expect(candidate.breakdown.cost).toBe(0);
    expect(candidate.constraints.find(c => c.constraint.attribute === 'total')?.outcome).toBe('unknown');
  });
  it('does not reward a missing item price', () => {
    const unknown = structuredClone(offers[0]); unknown.price.components = [];
    expect(computeTotal(unknown.price).isLowerBound).toBe(true);
    expect(rank([unknown]).ranked[0].breakdown.cost).toBe(0);
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
