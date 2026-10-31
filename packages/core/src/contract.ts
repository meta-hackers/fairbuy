// Adapted from fairbuy-alessandro-demo: validated facts retain their provenance.
import { z } from 'zod';

export const CurrencySchema = z.enum(['EUR', 'CHF', 'USD', 'GBP']);
export const EvidenceSchema = z.object({
  sourceType: z.enum(['url', 'screenshot', 'user_input']),
  ref: z.string(), snippet: z.string().optional(), at: z.iso.datetime(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;
export const FieldStatusSchema = z.enum(['verified', 'seller_claim', 'estimate', 'unknown']);
export type FieldStatus = z.infer<typeof FieldStatusSchema>;
export function fieldSchema<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion('status', [
    z.object({ status: z.literal('verified'), value, evidence: z.array(EvidenceSchema).min(1) }),
    z.object({ status: z.literal('seller_claim'), value, evidence: z.array(EvidenceSchema).min(1) }),
    z.object({ status: z.literal('estimate'), value, note: z.string() }),
    z.object({ status: z.literal('unknown') }),
  ]);
}
export type Field<T> =
  | { status: 'verified' | 'seller_claim'; value: T; evidence: Evidence[] }
  | { status: 'estimate'; value: T; note: string }
  | { status: 'unknown' };
export const AttrValueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('number'), value: z.number(), unit: z.string() }),
  z.object({ kind: z.literal('enum'), value: z.string() }),
  z.object({ kind: z.literal('bool'), value: z.boolean() }),
  z.object({ kind: z.literal('text'), value: z.string() }),
]);
export type AttrValue = z.infer<typeof AttrValueSchema>;
export const PriceBreakdownSchema = z.object({
  currency: CurrencySchema,
  components: z.array(z.object({
    kind: z.enum(['item', 'shipping', 'travel', 'accessory', 'other']),
    amountCents: z.number().int().nonnegative(), status: FieldStatusSchema,
    label: z.string().optional(),
  })),
  totalIsLowerBound: z.boolean(),
});
export type PriceBreakdown = z.infer<typeof PriceBreakdownSchema>;
export const OfferSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().min(1), category: z.string().min(1),
  mode: z.enum(['live', 'fixture']), provenanceUrl: z.string(), fetchedAt: z.iso.datetime(),
  availability: z.enum(['available', 'sold_out', 'stale', 'unknown']),
  title: z.string(), seller: z.string(),
  condition: fieldSchema(z.enum(['new', 'refurbished', 'used'])),
  price: PriceBreakdownSchema,
  attributes: z.record(z.string(), fieldSchema(AttrValueSchema)), missing: z.array(z.string()),
  evidence: z.array(EvidenceSchema).min(1),
});
export type Offer = z.infer<typeof OfferSchema>;
export const ConstraintSchema = z.object({
  attribute: z.string(), op: z.enum(['>=', '<=', '=', 'in']),
  value: z.union([z.number(), z.string(), z.boolean(), z.array(z.string())]), hard: z.boolean(),
});
export type Constraint = z.infer<typeof ConstraintSchema>;
export interface CategorySpec { id: string; attributes: { key: string; unit?: string }[] }
export const TOTAL_ATTRIBUTE = 'total';
