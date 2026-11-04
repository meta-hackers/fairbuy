import { z } from 'zod';
import { AskQuestionSchema, ConfigSchema, CurrencySchema, RequirementSchema } from '@fairbuy/core';

export const ConversationResultSchema = z.object({
  reply: z.string().min(1).max(4000), config: ConfigSchema,
  ready: z.boolean(), missing: z.array(z.string().max(200)).max(8),
  // Optional: the model decides whether a constrained question is useful. Null and
  // omission both mean a normal text-only reply, so older providers stay compatible.
  question: AskQuestionSchema.nullable().optional(),
});
export const LearnedResultSchema = z.object({
  requirements: z.array(RequirementSchema).max(5), summary: z.string().max(1000),
});
// Flat, bounded extraction schema compatible with schema-constrained (structured) output.
// Only the seller's final listed price is extracted; destination-dependent shipping,
// delivery and fees are intentionally absent.
export const ExtractionSchema = z.object({
  summary: z.string().max(3000),
  products: z.array(z.object({
    name: z.string().min(1).max(200), summary: z.string().max(1200), why: z.string().max(600),
    tradeoffs: z.array(z.string().max(400)).max(6),
    imageUrl: z.string().max(2000).nullable(),
    offers: z.array(z.object({
      url: z.string().max(2000), seller: z.string().max(150),
      // Major units: a laptop costs millions in currencies such as KRW, IDR or VND.
      price: z.number().nonnegative().max(10_000_000_000).nullable(),
      currency: CurrencySchema, availability: z.enum(['available', 'sold_out', 'unknown']),
      condition: z.enum(['new', 'refurbished', 'used', 'unknown']),
      quote: z.string().max(1200),
      attributes: z.array(z.object({
        key: z.string().max(80), text: z.string().max(300).nullable(), number: z.number().nullable(),
        boolean: z.boolean().nullable(), unit: z.string().max(40).nullable(), quote: z.string().max(800),
      })).max(25),
      missing: z.array(z.string().max(200)).max(15),
    })).min(1).max(4),
  })).max(8),
});
export type Extraction = z.infer<typeof ExtractionSchema>;
// Buy-stage seller search extracts offers only: the product and its features
// have already been chosen, so there is nothing to re-evaluate.
export const SellerExtractionSchema = z.object({
  summary: z.string().max(3000),
  offers: z.array(ExtractionSchema.shape.products.element.shape.offers.element).max(8),
});
export type SellerExtraction = z.infer<typeof SellerExtractionSchema>;
