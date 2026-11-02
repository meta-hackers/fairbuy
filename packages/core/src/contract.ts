// Adapted from fairbuy-alessandro-demo: validated facts retain their provenance.
import { z } from 'zod';

// Common currencies are listed first so the dropdowns stay usable, followed by
// every other ISO 4217 currency used by a country. No exchange rate is assumed.
export const CURRENCIES = [
  'EUR', 'USD', 'GBP', 'CHF', 'AUD', 'CAD', 'CNY', 'JPY', 'INR', 'BRL',
  'MXN', 'SGD', 'HKD', 'NZD', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF',
  'RON', 'TRY', 'ZAR', 'AED', 'SAR', 'QAR', 'ILS', 'KRW', 'THB', 'MYR',
  'IDR', 'PHP', 'VND', 'EGP', 'NGN', 'KES', 'MAD', 'UAH', 'ISK', 'CLP',
  'COP', 'ARS', 'PEN', 'TWD', 'BDT', 'PKR', 'LKR', 'NPR', 'RUB', 'RSD',
  'KZT', 'GEL', 'UYU', 'TTD', 'JMD', 'AFN', 'ALL', 'AMD', 'AOA', 'AWG',
  'AZN', 'BAM', 'BBD', 'BHD', 'BIF', 'BMD', 'BND', 'BOB', 'BSD', 'BTN',
  'BWP', 'BYN', 'BZD', 'CDF', 'CRC', 'CUP', 'CVE', 'DJF', 'DOP', 'DZD',
  'ERN', 'ETB', 'FJD', 'FKP', 'GHS', 'GIP', 'GMD', 'GNF', 'GTQ', 'GYD',
  'HNL', 'HTG', 'IQD', 'IRR', 'JOD', 'KGS', 'KHR', 'KMF', 'KPW', 'KWD',
  'KYD', 'LAK', 'LBP', 'LRD', 'LSL', 'LYD', 'MDL', 'MGA', 'MKD', 'MMK',
  'MNT', 'MOP', 'MRU', 'MUR', 'MVR', 'MWK', 'MZN', 'NAD', 'NIO', 'OMR',
  'PAB', 'PGK', 'PYG', 'RWF', 'SBD', 'SCR', 'SDG', 'SHP', 'SLE', 'SOS',
  'SRD', 'SSP', 'STN', 'SYP', 'SZL', 'TJS', 'TMT', 'TND', 'TOP', 'TZS',
  'UGX', 'UZS', 'VES', 'VUV', 'WST', 'XAF', 'XCD', 'XCG', 'XOF', 'XPF',
  'YER', 'ZMW', 'ZWG',
] as const;
export type Currency = (typeof CURRENCIES)[number];
export const CurrencySchema = z.enum(CURRENCIES);
export const COMMON_CURRENCIES = CURRENCIES.slice(0, 55);
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
// Discovery compares the seller's final listed price only. Shipping, delivery,
// taxes and fees depend on the destination and are deliberately not estimated.
export const FinalPriceSchema = z.object({
  currency: CurrencySchema,
  amountCents: z.number().int().nonnegative().nullable(),
});
export type FinalPrice = z.infer<typeof FinalPriceSchema>;
export const OfferSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().min(1), category: z.string().min(1),
  mode: z.enum(['live', 'fixture']), provenanceUrl: z.string(), fetchedAt: z.iso.datetime(),
  availability: z.enum(['available', 'sold_out', 'stale', 'unknown']),
  title: z.string(), seller: z.string(),
  condition: fieldSchema(z.enum(['new', 'refurbished', 'used'])),
  price: FinalPriceSchema,
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
