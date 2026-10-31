import { z } from 'zod';
import { ConfigSchema, CurrencySchema, RequirementSchema } from '@fairbuy/core';

export const ConversationResultSchema = z.object({
  reply: z.string().min(1).max(4000), config: ConfigSchema,
  ready: z.boolean(), missing: z.array(z.string().max(200)).max(8),
});
export const LearnedResultSchema = z.object({
  requirements: z.array(RequirementSchema).max(5), summary: z.string().max(1000),
});
// Flat, bounded extraction schema compatible with schema-constrained (structured) output.
export const ExtractionSchema = z.object({
  summary: z.string().max(3000),
  products: z.array(z.object({
    name: z.string().min(1).max(200), summary: z.string().max(1200), why: z.string().max(600),
    tradeoffs: z.array(z.string().max(400)).max(6),
    offers: z.array(z.object({
      url: z.string().max(2000), seller: z.string().max(150),
      price: z.number().nonnegative().max(1000000).nullable(),
      shipping: z.number().nonnegative().max(100000).nullable(), fees: z.number().nonnegative().max(100000).nullable(),
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
