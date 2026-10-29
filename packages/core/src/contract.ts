// Shared data contract, as proposed in meta-hackers/fairbuy#1.
// Zod schemas are the source of truth: TypeScript types are inferred from them,
// and the same schemas validate connector and model output at runtime.
import { z } from "zod";

export const SCHEMA_VERSION = 1;

// --- Evidence -----------------------------------------------------------------

export const EvidenceSchema = z.object({
  sourceType: z.enum(["url", "screenshot", "user_input"]),
  ref: z.string(),
  snippet: z.string().optional(),
  at: z.iso.datetime(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

// --- Field<T>: every value knows where it comes from ---------------------------

export const FieldStatusSchema = z.enum(["verified", "seller_claim", "estimate", "unknown"]);
export type FieldStatus = z.infer<typeof FieldStatusSchema>;

export function fieldSchema<T extends z.ZodTypeAny>(value: T) {
  return z.discriminatedUnion("status", [
    z.object({ status: z.literal("verified"), value, evidence: z.array(EvidenceSchema) }),
    z.object({ status: z.literal("seller_claim"), value, evidence: z.array(EvidenceSchema) }),
    z.object({ status: z.literal("estimate"), value, note: z.string() }),
    z.object({ status: z.literal("unknown") }),
  ]);
}

export type Field<T> =
  | { status: "verified"; value: T; evidence: Evidence[] }
  | { status: "seller_claim"; value: T; evidence: Evidence[] }
  | { status: "estimate"; value: T; note: string }
  | { status: "unknown" };

// --- Attribute values ------------------------------------------------------------

export const AttrValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("number"), value: z.number(), unit: z.string() }),
  z.object({ kind: z.literal("enum"), value: z.string() }),
  z.object({ kind: z.literal("bool"), value: z.boolean() }),
  z.object({ kind: z.literal("text"), value: z.string() }),
]);
export type AttrValue = z.infer<typeof AttrValueSchema>;

// --- Price ----------------------------------------------------------------------

export const PriceComponentSchema = z.object({
  kind: z.enum(["item", "shipping", "travel", "accessory", "other"]),
  amountCents: z.number().int().nonnegative(),
  status: FieldStatusSchema,
  label: z.string().optional(),
});
export type PriceComponent = z.infer<typeof PriceComponentSchema>;

export const PriceBreakdownSchema = z.object({
  currency: z.literal("EUR"),
  components: z.array(PriceComponentSchema),
  // true when a known cost is missing: the sum is a minimum, not the total.
  totalIsLowerBound: z.boolean(),
});
export type PriceBreakdown = z.infer<typeof PriceBreakdownSchema>;

// --- Offer ----------------------------------------------------------------------

export const OfferSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string().min(1),
  category: z.string().min(1),
  mode: z.enum(["live", "fixture"]),
  provenanceUrl: z.string(),
  fetchedAt: z.iso.datetime(),
  availability: z.enum(["available", "sold_out", "stale", "unknown"]),
  title: z.string(),
  condition: fieldSchema(z.enum(["new", "refurbished", "used"])),
  price: PriceBreakdownSchema,
  attributes: z.record(z.string(), fieldSchema(AttrValueSchema)),
  missing: z.array(z.string()),
});
export type Offer = z.infer<typeof OfferSchema>;

// --- Category spec: what makes a category a category (configuration, not code) ---

export const AttributeDefSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(["number", "enum", "bool", "text"]),
  unit: z.string().optional(),
  better: z.enum(["higher", "lower"]).optional(),
});
export type AttributeDef = z.infer<typeof AttributeDefSchema>;

export const CategorySpecSchema = z.object({
  id: z.string(),
  label: z.string(),
  attributes: z.array(AttributeDefSchema),
});
export type CategorySpec = z.infer<typeof CategorySpecSchema>;

// --- Constraints ----------------------------------------------------------------

// Pseudo-attribute for the delivered total, in cents.
export const TOTAL_ATTRIBUTE = "total";

export const ConstraintSchema = z.object({
  attribute: z.string(),
  op: z.enum([">=", "<=", "=", "in"]),
  value: z.union([z.number(), z.string(), z.boolean(), z.array(z.string())]),
  // hard = excludes the offer when violated; soft = affects the score only.
  hard: z.boolean(),
});
export type Constraint = z.infer<typeof ConstraintSchema>;

// --- Connector errors -------------------------------------------------------------

export const ConnectorErrorSchema = z.object({
  type: z.enum(["timeout", "unreachable", "rate_limited", "invalid_response", "forbidden"]),
  at: z.iso.datetime(),
  retryable: z.boolean(),
  // Redacted, human-readable message. Never secrets, tokens, or signed URLs.
  message: z.string().optional(),
});
export type ConnectorError = z.infer<typeof ConnectorErrorSchema>;
