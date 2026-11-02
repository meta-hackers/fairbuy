import { z } from 'zod';
import { CurrencySchema, type Currency } from './contract';

export const InstantClassifierInputSchema = z.object({ text: z.string().trim().min(3).max(3000) }).strict();
const EvidenceSchema = z.string().min(1).max(240);
// These are draft hints, deliberately not ShoppingConfig or independently verified facts.
export const InstantClassificationSchema = z.object({
  category: z.object({ value: z.string().min(1).max(80), evidence: EvidenceSchema }).strict().nullable(),
  budget: z.object({
    amount: z.number().positive().max(1000000), currency: CurrencySchema.nullable(),
    hard: z.boolean(), evidence: EvidenceSchema,
  }).strict().nullable(),
  condition: z.object({ value: z.enum(['new', 'used', 'refurbished']), evidence: EvidenceSchema }).strict().nullable(),
  requirements: z.array(z.object({
    label: z.string().min(1).max(100), hard: z.boolean(), evidence: EvidenceSchema,
  }).strict()).max(5),
  clarification: z.string().min(1).max(180).nullable(),
}).strict();
export type InstantClassification = z.infer<typeof InstantClassificationSchema>;

const normalize = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
function tokens(text: string) { return new Set((normalize(text).match(/[\p{L}\p{N}]+/gu) ?? [])); }
function hasAmount(evidence: string, amount: number) {
  return (evidence.match(/\d+(?:[.,'’]\d+)*(?:[ \u00a0]\d{3})*/g) ?? []).some(token => {
    const digits = token.replace(/[ '\u00a0’]/g, '');
    const decimal = digits.match(/([.,])(\d{1,2})$/);
    const value = decimal ? Number(digits.slice(0, decimal.index).replace(/[.,]/g, '') + '.' + decimal[2]) : Number(digits.replace(/[.,]/g, ''));
    return value === amount;
  });
}
const currencySymbols: Partial<Record<Currency, RegExp>> = {
  EUR: /€|\beuros?\b/i, CHF: /\bswiss francs?\b/i, USD: /us\$|\bus dollars?\b/i, GBP: /£|\bpounds?\b/i,
  AUD: /a\$|\baustralian dollars?\b/i, CAD: /c(?:a)?\$|\bcanadian dollars?\b/i, CNY: /\brmb\b|\byuan\b|元/i,
  JPY: /\byen\b|円/i, INR: /₹|\brupees?\b/i, BRL: /r\$|\breais\b/i, MXN: /mx\$/i,
  SGD: /s\$|\bsingapore dollars?\b/i, HKD: /hk\$|\bhong kong dollars?\b/i, NZD: /nz\$|\bnew zealand dollars?\b/i,
  PLN: /zł/i, CZK: /kč/i, HUF: /\bft\b/i, TRY: /₺|\bliras?\b/i, ILS: /₪|\bshekels?\b/i,
  KRW: /₩|\bwon\b/i, THB: /฿|\bbaht\b/i, MYR: /\brm\b|\bringgit\b/i, IDR: /\brp\b|\brupiah\b/i,
  PHP: /₱|\bpiso\b/i, VND: /₫|\bdong\b/i, NGN: /₦|\bnaira\b/i, UAH: /₴|\bhryvnia\b/i,
  RUB: /₽|\brubles?\b/i, KZT: /₸|\btenge\b/i, GEL: /₾|\blari\b/i, BDT: /৳|\btaka\b/i,
  TWD: /nt\$/i,
};
function hasCurrencyMarker(currency: Currency, evidence: string) {
  return new RegExp(`\\b${currency}\\b`, 'i').test(evidence) || currencySymbols[currency]?.test(evidence) === true;
}
const conditionMarkers = {
  new: /\b(new|neuf|neuve|neu|nuovo|nuova)\b/,
  used: /\b(used|second[ -]?hand|occasion|gebraucht|usato|usata)\b/,
  refurbished: /\b(refurbished|renewed|reconditionne|reconditionnee|generaluberholt|ricondizionato|ricondizionata)\b/,
};

const collapse = (text: string) => normalize(text).replace(/\s+/g, ' ').trim();
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function groundInstantClassification(value: unknown, text: string): InstantClassification {
  const parsed = InstantClassificationSchema.parse(value);
  // Evidence must quote whole words of the draft. Case, accents and spacing may
  // differ, so "Laptop" grounds in "laptop", but "Mac" never grounds in "machine".
  const draft = collapse(text);
  const grounded = (evidence: string) => {
    const quote = collapse(evidence);
    return !!quote && new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(quote)}(?![\\p{L}\\p{N}])`, 'u').test(draft);
  };
  let budget = parsed.budget && grounded(parsed.budget.evidence) && hasAmount(parsed.budget.evidence, parsed.budget.amount) ? parsed.budget : null;
  if (budget) {
    if (budget.currency && !hasCurrencyMarker(budget.currency, budget.evidence)) budget = { ...budget, currency: null };
    // Small models often leave the currency empty for "500 euro" or "400 €". The quote
    // itself names it, so fill it only when exactly one currency is unmistakable.
    if (!budget.currency) {
      const named = CurrencySchema.options.filter(currency => hasCurrencyMarker(currency, budget!.evidence));
      if (named.length === 1) budget = { ...budget, currency: named[0] };
    }
    // A model must not silently turn an approximate budget into a hard ceiling.
    if (/\b(around|about|approximately|environ|circa|ungefahr)\b/.test(normalize(budget.evidence))) budget = { ...budget, hard: false };
  }
  return {
    category: parsed.category && grounded(parsed.category.evidence)
      && (normalize(parsed.category?.value ?? '').match(/[\p{L}\p{N}]+/gu) ?? []).some(word => word.length > 1 && tokens(parsed.category?.evidence ?? '').has(word)) ? parsed.category : null,
    budget,
    condition: parsed.condition && grounded(parsed.condition.evidence) && conditionMarkers[parsed.condition.value].test(normalize(parsed.condition.evidence)) ? parsed.condition : null,
    requirements: parsed.requirements.filter(requirement => grounded(requirement.evidence)
      && (normalize(requirement.label).match(/[\p{L}\p{N}]+/gu) ?? []).some(word => word.length > 1 && tokens(requirement.evidence).has(word))),
    clarification: parsed.clarification,
  };
}

export interface InstantHint { kind: 'Category' | 'Budget' | 'Condition' | 'Requirement'; text: string; evidence: string }
/** Every validated hint in display order, so nothing the classifier found stays invisible. */
export function instantHints(result: InstantClassification): InstantHint[] {
  const hints: InstantHint[] = [];
  if (result.category) hints.push({ kind: 'Category', text: result.category.value, evidence: result.category.evidence });
  if (result.budget) {
    const amount = result.budget.amount.toLocaleString('en');
    const money = result.budget.currency ? `${result.budget.currency} ${amount}` : amount;
    hints.push({ kind: 'Budget', text: `${money} · ${result.budget.hard ? 'firm' : 'flexible'}`, evidence: result.budget.evidence });
  }
  if (result.condition) hints.push({ kind: 'Condition', text: result.condition.value, evidence: result.condition.evidence });
  for (const requirement of result.requirements) {
    hints.push({ kind: 'Requirement', text: `${requirement.label}${requirement.hard ? ' · must-have' : ''}`, evidence: requirement.evidence });
  }
  return hints;
}
