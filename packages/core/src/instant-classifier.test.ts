import { describe, expect, it } from 'vitest';
import { InstantClassifierInputSchema, groundInstantClassification } from './instant-classifier';

const empty = { category: null, budget: null, condition: null, requirements: [], clarification: null };
describe('provisional instant-classifier contracts', () => {
  it('retains exact evidence without turning hints into shopping configuration', () => {
    const draft = 'A used laptop, max EUR 700, at least 16 GB RAM';
    const result = groundInstantClassification({
      category: { value: 'Laptop', evidence: 'laptop' },
      budget: { amount: 700, currency: 'EUR', hard: true, evidence: 'max EUR 700' },
      condition: { value: 'used', evidence: 'used' },
      requirements: [{ label: 'RAM ≥ 16 GB', hard: true, evidence: 'at least 16 GB RAM' }], clarification: null,
    }, draft);
    expect(result.budget?.amount).toBe(700);
    expect(result.requirements[0].evidence).toBe('at least 16 GB RAM');
    expect(result).not.toHaveProperty('ready');
    expect(result).not.toHaveProperty('country');
  });
  it('drops hints without exact case-sensitive evidence and permits abstention', () => {
    const result = groundInstantClassification({
      category: { value: 'Computer', evidence: 'Mac' }, budget: null,
      condition: { value: 'new', evidence: 'new' },
      requirements: [{ label: 'Quiet', hard: false, evidence: 'quiet' }],
      clarification: 'What product would you like?',
    }, 'washing machine');
    expect(result).toEqual({ ...empty, clarification: 'What product would you like?' });
  });
  it('does not invent currency for an ambiguous amount', () => {
    expect(groundInstantClassification({ ...empty, budget: { amount: 700, currency: null, hard: false, evidence: 'around 700' } }, 'around 700').budget?.currency).toBeNull();
  });
  it('rejects invented amounts, currencies, conditions and unrelated requirement labels even when the quote exists', () => {
    const draft = 'I need a washing machine';
    const result = groundInstantClassification({
      ...empty, budget: { amount: 500, currency: 'EUR', hard: true, evidence: draft },
      condition: { value: 'new', evidence: draft },
      requirements: [{ label: 'Energy efficiency', hard: false, evidence: draft }],
    }, draft);
    expect(result).toEqual(empty);
    expect(groundInstantClassification({ ...empty, budget: { amount: 700, currency: 'USD', hard: true, evidence: '$700' } }, '$700').budget?.currency).toBeNull();
    expect(groundInstantClassification({ ...empty, budget: { amount: 700, currency: 'EUR', hard: true, evidence: 'around EUR 700' } }, 'around EUR 700').budget?.hard).toBe(false);
  });
  it.each([
    ['CHF 1’299.90', 1299.9, 'CHF'], ['EUR 1.299,90', 1299.9, 'EUR'], ['€1 299', 1299, 'EUR'], ['GBP 700', 700, 'GBP'],
    ['JPY 80,000', 80000, 'JPY'], ['50 CAD', 50, 'CAD'], ['INR 25,000', 25000, 'INR'],
  ])('validates amounts in %s without introducing an exchange rate', (evidence, amount, currency) => {
    expect(groundInstantClassification({ ...empty, budget: { amount, currency, hard: true, evidence } }, evidence).budget?.amount).toBe(amount);
  });
  it('bounds inputs and rejects unknown currencies', () => {
    for (const text of ['', 'ab', 'a'.repeat(3001)]) expect(InstantClassifierInputSchema.safeParse({ text }).success).toBe(false);
    expect(InstantClassifierInputSchema.parse({ text: '  baby  ' }).text).toBe('baby');
    expect(() => groundInstantClassification({ ...empty, budget: { amount: 50, currency: 'XYZ', hard: true, evidence: '50 XYZ' } }, '50 XYZ')).toThrow();
    expect(() => groundInstantClassification({ ...empty, expectedPrice: 500 }, 'laptop')).toThrow();
    // A bare currency symbol stays ambiguous; an explicit code or unmistakable symbol is required.
    expect(groundInstantClassification({ ...empty, budget: { amount: 700, currency: 'JPY', hard: true, evidence: '¥700' } }, '¥700').budget?.currency).toBeNull();
  });
});
