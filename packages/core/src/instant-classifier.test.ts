import { describe, expect, it } from 'vitest';
import { InstantClassifierInputSchema, groundInstantClassification, instantHints } from './instant-classifier';

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
  it('drops hints whose evidence is not a whole-word quote and permits abstention', () => {
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
  it('grounds quotes that differ only in case, accents or spacing, but never part of a word', () => {
    const draft = 'Cerco un Portatile usato,  almeno 16 GB  di RAM';
    const result = groundInstantClassification({
      category: { value: 'Portatile', evidence: 'portatile' }, budget: null,
      condition: { value: 'used', evidence: 'Usato' },
      requirements: [{ label: '16 GB RAM', hard: true, evidence: 'almeno 16 GB di RAM' }, { label: 'Port', hard: false, evidence: 'Port' }],
      clarification: null,
    }, draft);
    expect(result.category?.value).toBe('Portatile');
    expect(result.condition?.value).toBe('used');
    expect(result.requirements.map(r => r.label)).toEqual(['16 GB RAM']);
  });
  it('lists every validated hint for display, not only requirements', () => {
    expect(instantHints({
      category: { value: 'Laptop', evidence: 'laptop' },
      budget: { amount: 1200, currency: 'EUR', hard: false, evidence: 'around EUR 1200' },
      condition: { value: 'used', evidence: 'used' },
      requirements: [{ label: 'at least 16 GB RAM', hard: true, evidence: 'at least 16 GB RAM' }, { label: 'coding', hard: false, evidence: 'for coding' }],
      clarification: null,
    })).toEqual([
      { kind: 'Category', text: 'Laptop', evidence: 'laptop' },
      { kind: 'Budget', text: 'EUR 1,200 · flexible', evidence: 'around EUR 1200' },
      { kind: 'Condition', text: 'used', evidence: 'used' },
      { kind: 'Requirement', text: 'at least 16 GB RAM · must-have', evidence: 'at least 16 GB RAM' },
      { kind: 'Requirement', text: 'coding', evidence: 'for coding' },
    ]);
    expect(instantHints({ ...empty, budget: { amount: 700, currency: null, hard: true, evidence: 'max 700' } })).toEqual([{ kind: 'Budget', text: '700 · firm', evidence: 'max 700' }]);
    expect(instantHints({ ...empty, clarification: 'Which baby product?' })).toEqual([]);
  });
  it('fills a missing currency only when the budget quote names exactly one', () => {
    const budget = (evidence: string, currency: string | null = null) =>
      groundInstantClassification({ ...empty, budget: { amount: 500, currency, hard: false, evidence } }, evidence).budget?.currency;
    expect(budget('circa 500 euro')).toBe('EUR');
    expect(budget('environ 500 €')).toBe('EUR');
    expect(budget('bis 500 CHF')).toBe('CHF');
    expect(budget('budget $500')).toBeNull();
    expect(budget('¥500')).toBeNull();
    expect(budget('500 EUR or CHF 500')).toBeNull();
    expect(budget('around 500')).toBeNull();
  });
});
