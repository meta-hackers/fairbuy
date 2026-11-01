import { z } from 'zod';
import { CurrencySchema, type Constraint, type Offer } from './contract';
import { rankOffers, type ComparisonResult } from './ranking';

export const DISCOVERY_MIN_PRODUCTS = 4;

export const RequirementSchema = z.object({
  label: z.string().min(1).max(300), hard: z.boolean(),
  attribute: z.string().max(80).nullable(), op: z.enum(['>=', '<=', '=']).nullable(),
  value: z.union([z.number(), z.string().max(300), z.boolean(), z.null()]), unit: z.string().max(40).nullable(),
});
export type Requirement = z.infer<typeof RequirementSchema>;
export const ConfigSchema = z.object({
  category: z.string().max(100).nullable(), purpose: z.string().max(500).nullable(),
  budgetMax: z.number().positive().max(1000000).nullable(), budgetHard: z.boolean(),
  currency: CurrencySchema, country: z.string().regex(/^[A-Z]{2}$/).nullable(), city: z.string().max(120).nullable(),
  requirements: z.array(RequirementSchema).max(20),
});
export type ShoppingConfig = z.infer<typeof ConfigSchema>;
export const EMPTY_CONFIG: ShoppingConfig = { category: null, purpose: null, budgetMax: null, budgetHard: false, currency: 'EUR', country: null, city: null, requirements: [] };
export const MessageInputSchema = z.object({ message: z.string().trim().min(1).max(3000) }).strict();
export const LearnInputSchema = z.object({ productId: z.string().max(100).nullable(), reason: z.string().trim().min(1).max(2000) }).strict();
export interface ChatMessage { role: 'user' | 'assistant'; content: string }
export interface Product {
  id: string; name: string; summary: string; why: string; tradeoffs: string[]; offers: Offer[];
  imageUrl: string | null;
}
export interface Source { url: string; title: string }
export interface Feedback { id: string; productId: string | null; productName: string | null; reason: string; at: string; learned: Requirement[] }
export interface DiscoveryContext {
  sessionId: string; discoverySessionId: string; initialRequest: string; initialConfig: ShoppingConfig; config: ShoppingConfig;
  previousProducts: Product[]; discardedProducts: Product[]; feedback: Feedback[];
}
export interface DiscoveryRound {
  id: string; number: number; attempt: number; trigger: 'configure' | 'learn' | 'refresh';
  status: 'queued' | 'running' | 'complete' | 'failed';
  createdAt: string; startedAt: string | null; finishedAt: string | null; durationMs: number | null;
  products: Product[]; sources: Source[]; summary: string; error: string | null;
  context: DiscoveryContext; ranking: ComparisonResult | null;
}
export interface ShoppingSession {
  id: string; version: number; mode: 'live' | 'demo'; createdAt: string; updatedAt: string;
  stage: 'ask' | 'configure' | 'discovery' | 'buy';
  askSessionId: string; configureSessionId: string;
  askMessages: ChatMessage[]; configureMessages: ChatMessage[];
  config: ShoppingConfig; initialConfig: ShoppingConfig | null; ready: boolean; missing: string[];
  feedback: Feedback[]; rounds: DiscoveryRound[]; selectedProductId: string | null;
}
export function constraintsFor(config: ShoppingConfig): Constraint[] {
  const constraints: Constraint[] = config.requirements.map((r, i) => ({
    attribute: r.attribute ?? `uninterpreted_${i}`, op: r.op ?? '=', value: r.value ?? r.label, hard: r.hard,
  }));
  if (config.budgetMax !== null) constraints.unshift({ attribute: 'total', op: '<=', value: Math.round(config.budgetMax * 100), hard: config.budgetHard });
  return constraints;
}
// Latest explicit feedback about the same attribute refines, rather than contradicts,
// an earlier requirement. Original/base configs remain immutable audit context.
export function effectiveConfig(context: DiscoveryContext): ShoppingConfig {
  const config = structuredClone(context.config);
  for (const learned of context.feedback.flatMap(f => f.learned)) {
    if (learned.attribute === 'total' && typeof learned.value === 'number' && learned.op === '<=' && learned.value > 0) {
      config.budgetMax = learned.value / 100; config.budgetHard = learned.hard;
    } else {
      if (learned.attribute) config.requirements = config.requirements.filter(r => r.attribute !== learned.attribute);
      config.requirements.push(learned);
    }
  }
  return config;
}
export function isConfigReady(config: ShoppingConfig) { return !!(config.category?.trim() && config.purpose?.trim() && config.country); }
export function rankProducts(products: Product[], context: DiscoveryContext): ComparisonResult {
  const config = effectiveConfig(context);
  return rankOffers({
    offers: products.flatMap(p => p.offers), constraints: constraintsFor(config), currency: config.currency,
    spec: { id: config.category ?? 'products', attributes: config.requirements.filter(r => r.attribute).map(r => ({ key: r.attribute!, unit: r.unit ?? undefined })) },
  });
}
export function allProducts(session: ShoppingSession): Product[] {
  return [...new Map(session.rounds.flatMap(r => r.products).map(p => [p.id, p])).values()];
}
export function latestRound(session: ShoppingSession) { return session.rounds.at(-1); }
export function activeProducts(session: ShoppingSession) {
  const discarded = new Set(session.feedback.map(f => f.productId));
  return (latestRound(session)?.products ?? []).filter(p => !discarded.has(p.id));
}
