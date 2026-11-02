import { describe, expect, it } from 'vitest';
import { DemoAIProvider } from '../../../backend/src/ai/demo';
import { EMPTY_CONFIG, rankProducts, type DiscoveryContext, type DiscoveryRound, type Product, type ShoppingSession } from './index';
import { explainMissing, mentionsProduct } from './missing';

const context: DiscoveryContext = {
  sessionId: 's', discoverySessionId: 'r', initialRequest: 'Laptop', initialConfig: EMPTY_CONFIG,
  config: { ...EMPTY_CONFIG, category: 'laptop', purpose: 'coding', country: 'IT', budgetMax: 700, budgetHard: true }, previousProducts: [], discardedProducts: [], feedback: [],
};
const fixtures = (await new DemoAIProvider().discover(context)).products;
// Live offers, as discovery stores them, so answers count retrieved pages.
const catalog = fixtures.map(p => ({ ...p, offers: p.offers.map(o => ({ ...o, mode: 'live' as const })) }));
const named = (name: string) => catalog.find(p => p.name === name)!;

function session(products: Product[], extra: Partial<DiscoveryRound> = {}, feedback: ShoppingSession['feedback'] = []): ShoppingSession {
  const round: DiscoveryRound = {
    id: 'r', number: 1, attempt: 1, trigger: 'configure', status: 'complete', createdAt: '', startedAt: null, finishedAt: null, durationMs: 1,
    products, sources: [{ url: 'https://shop.example.org/aster', title: 'Aster 14 laptop' }], summary: '', error: null, context, ranking: rankProducts(products, context), ...extra,
  };
  return {
    id: 's', version: 1, mode: 'live', createdAt: '', updatedAt: '', stage: 'discovery', askSessionId: 'a', configureSessionId: 'c',
    askMessages: [], configureMessages: [], config: context.config, initialConfig: null, ready: true, missing: [], feedback, rounds: [round], selectedProductId: null,
  };
}

describe('mentionsProduct', () => {
  it('matches most of the words or the reference number, not one shared word', () => {
    expect(mentionsProduct('Omega Speedmaster', 'Omega Speedmaster Professional Moonwatch')).toBe(true);
    expect(mentionsProduct('speedmaster', 'Omega Speedmaster Professional')).toBe(true);
    expect(mentionsProduct('the 310.30.42.50.01.001', 'Omega 310 30 42 50 01 001 chronograph')).toBe(true);
    expect(mentionsProduct('Omega Seamaster', 'Omega Speedmaster Professional')).toBe(false);
    expect(mentionsProduct('the', 'The laptop')).toBe(false);
  });
});

describe('explainMissing (issue #23)', () => {
  it('says when the product is already in the results', () => {
    const answer = explainMissing(session(catalog), 'Moss Book 14');
    expect(answer).toMatchObject({ cause: 'shown', product: 'Moss Book 14' });
  });

  it('points to feedback when the user removed it', () => {
    const answer = explainMissing(session(catalog, {}, [{ id: 'f', productId: named('Vale Pro 14').id, productName: 'Vale Pro 14', reason: 'Too heavy', at: '', learned: [] }]), 'Vale Pro 14');
    expect(answer).toMatchObject({ cause: 'discarded', reasons: ['Your feedback: “Too heavy”'] });
    expect(answer.nextSteps[0]).toContain('Undo that feedback');
  });

  it('gives the exclusion reasons and a next step that fits them', () => {
    const answer = explainMissing(session(catalog), 'Vale Pro 14');
    expect(answer.cause).toBe('excluded');
    expect(answer.reasons).toEqual(['Final listed price does not meet your budget']);
    expect(answer.nextSteps).toEqual(['Raise the budget or make it flexible in Configure.']);
    expect(answer.searched).toBe('Searched 1 page for laptop in IT, prices in EUR, budget up to 700.');
  });

  it('explains offers that were found but could not be verified', () => {
    const answer = explainMissing(session([], { dropped: [{ reason: 'quote_not_grounded', product: 'Birch 15', seller: 'Shop', host: 'shop.example.org' }] }), 'Birch 15');
    expect(answer).toMatchObject({ cause: 'dropped', reasons: ['Shop: Its quoted evidence was not found on the returned pages'] });
  });

  it('separates a page that mentioned it from a product never retrieved', () => {
    expect(explainMissing(session([]), 'Aster 14').cause).toBe('mentioned');
    const answer = explainMissing(session([]), 'Omega Speedmaster');
    expect(answer.cause).toBe('not_retrieved');
    expect(answer.summary).toContain('not found, rather than rejected');
  });

  it('describes the demo catalog honestly instead of counting zero pages', () => {
    const answer = explainMissing(session(fixtures, { sources: [] }), 'Omega Speedmaster');
    expect(answer).toMatchObject({ cause: 'not_retrieved', summary: 'It is not in the synthetic demo catalog.' });
    expect(answer.searched).toBe('Checked the synthetic demo catalog for laptop in IT, prices in EUR, budget up to 700.');
  });

  it('admits when the cause cannot be determined', () => {
    expect(explainMissing(session([], { sources: [] }), 'Omega Speedmaster').cause).toBe('unknown');
    expect(explainMissing(session([], { status: 'running' }), 'Omega Speedmaster').summary).toContain('still running');
    expect(explainMissing({ ...session([]), rounds: [] }, 'Omega Speedmaster').summary).toContain('No search has run yet');
  });
});
