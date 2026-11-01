import { z } from 'zod';
import { CurrencySchema } from './contract';

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
function hasAmount(evidence: string, amount: number) {
  return (evidence.match(/\d+(?:[.,'’]\d+)*(?:[ \u00a0]\d{3})*/g) ?? []).some(token => {
    const digits = token.replace(/[ '\u00a0’]/g, '');
    const decimal = digits.match(/([.,])(\d{1,2})$/);
    const value = decimal ? Number(digits.slice(0, decimal.index).replace(/[.,]/g, '') + '.' + decimal[2]) : Number(digits.replace(/[.,]/g, ''));
    return value === amount;
  });
}
const currencyMarkers = { EUR: /\beur\b|€|\beuros?\b/i, CHF: /\bchf\b|\bswiss francs?\b/i, USD: /\busd\b|us\$/i, GBP: /\bgbp\b|£/i };
const conditionMarkers = {
  new: /\b(new|neuf|neuve|neu|nuovo|nuova)\b/,
  used: /\b(used|second[ -]?hand|occasion|gebraucht|usato|usata)\b/,
  refurbished: /\b(refurbished|renewed|reconditionne|reconditionnee|generaluberholt|ricondizionato|ricondizionata)\b/,
};

export function groundInstantClassification(value: unknown, text: string): InstantClassification {
  const parsed = InstantClassificationSchema.parse(value);
  const grounded = (evidence: string) => text.includes(evidence);
  let budget = parsed.budget && grounded(parsed.budget.evidence) && hasAmount(parsed.budget.evidence, parsed.budget.amount) ? parsed.budget : null;
  if (budget) {
    if (budget.currency && !currencyMarkers[budget.currency].test(budget.evidence)) budget = { ...budget, currency: null };
    // A model must not silently turn an approximate budget into a hard ceiling.
    if (/\b(around|about|approximately|environ|circa|ungefahr)\b/.test(normalize(budget.evidence))) budget = { ...budget, hard: false };
  }
  return {
    category: parsed.category && grounded(parsed.category.evidence) ? parsed.category : null,
    budget,
    condition: parsed.condition && grounded(parsed.condition.evidence) && conditionMarkers[parsed.condition.value].test(normalize(parsed.condition.evidence)) ? parsed.condition : null,
    requirements: parsed.requirements.filter(requirement => grounded(requirement.evidence)
      && (normalize(requirement.label).match(/[\p{L}\p{N}]+/gu) ?? []).some(word => word.length > 2 && normalize(requirement.evidence).includes(word))),
    clarification: parsed.clarification,
  };
}
