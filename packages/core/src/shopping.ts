import { z } from 'zod';
import { CurrencySchema, TOTAL_ATTRIBUTE, UNINTERPRETED_PREFIX, type Constraint, type Offer } from './contract';
import { currencyForCountry } from './location';
import type { MissingQuestion } from './missing';
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
/** A bounded, optional structured question the Ask model may attach to a reply. */
export const AskQuestionOptionSchema = z.object({
  id: z.string().min(1).max(40), label: z.string().min(1).max(160),
});
export const AskQuestionSchema = z.object({
  prompt: z.string().min(1).max(300),
  options: z.array(AskQuestionOptionSchema).min(2).max(6).refine(
    options => new Set(options.map(option => option.id)).size === options.length,
    { message: 'Question option ids must be unique' },
  ),
  multiSelect: z.boolean(),
  // Kept for wire compatibility; the UI always offers a free-text answer.
  allowFreeText: z.boolean().default(true),
});
export type AskQuestionOption = z.infer<typeof AskQuestionOptionSchema>;
export type AskQuestion = z.infer<typeof AskQuestionSchema>;
export interface ChatMessage {
  role: 'user' | 'assistant'; content: string;
  /** Present on an assistant reply that offers quick choices. Older stored messages have none. */
  question?: AskQuestion | null;
}
/** The plain-text message sent through the existing Ask endpoint for a card answer. */
export function formatQuestionAnswer(options: AskQuestionOption[], selectedIds: string[], freeText: string): string {
  const selected = new Set(selectedIds);
  const labels = options.filter(option => selected.has(option.id)).map(option => option.label);
  const other = freeText.trim();
  return [labels.join(', '), other].filter(Boolean).join(' — ');
}
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
/** Why an extracted offer never reached ranking. Ranking exclusions live in `ranking.excluded`. */
export const DROP_REASONS = {
  url_not_in_sources: 'Its link was not among the pages this search returned',
  quote_not_grounded: 'Its quoted evidence was not found on the returned pages',
  not_a_seller: 'The page is a specification, review or comparison site, not a seller',
  previously_discarded: 'You removed this product earlier',
  duplicate: 'Same model listed twice; its offers were merged',
} as const;
export type DropReason = keyof typeof DROP_REASONS;
export interface DroppedOffer { reason: DropReason; product: string; seller: string | null; host: string | null }
/** Keeps stored diagnostics bounded; the summary still counts every drop. */
export const MAX_DROPPED = 50;
export const MAX_DISCOVERY_ACTIVITIES = 50;
export interface DiscoveryActivity { message: string; at: string }
export interface DiscoveryRound {
  id: string; number: number; attempt: number; trigger: 'configure' | 'learn' | 'refresh';
  status: 'queued' | 'running' | 'complete' | 'failed';
  createdAt: string; startedAt: string | null; finishedAt: string | null; durationMs: number | null;
  products: Product[]; sources: Source[]; summary: string; error: string | null;
  context: DiscoveryContext; ranking: ComparisonResult | null;
  /** Actual research milestones, newest last. Absent on older stored rounds. */
  activities?: DiscoveryActivity[];
  /** Absent on rounds stored before diagnostics existed. */
  dropped?: DroppedOffer[];
  /** "Why isn't it here?" questions asked about this round, newest last. */
  missingQuestions?: MissingQuestion[];
}
/**
 * Additional seller offers for the product the user chose in Buy. This is a
 * narrow, same-market search for the exact same model: it never re-ranks the
 * shortlist or re-evaluates the brief's preferences.
 */
export interface SellerSearch {
  id: string; productId: string; productName: string; attempt: number;
  status: 'queued' | 'running' | 'complete' | 'failed';
  createdAt: string; startedAt: string | null; finishedAt: string | null; durationMs: number | null;
  offers: Offer[]; sources: Source[]; summary: string; error: string | null;
  /** Actual search milestones, newest last. */
  activities?: DiscoveryActivity[];
}
export interface ShoppingSession {
  id: string; version: number; mode: 'live' | 'demo'; createdAt: string; updatedAt: string;
  stage: 'ask' | 'configure' | 'discovery' | 'buy';
  askSessionId: string; configureSessionId: string;
  askMessages: ChatMessage[]; configureMessages: ChatMessage[];
  config: ShoppingConfig; initialConfig: ShoppingConfig | null; ready: boolean; missing: string[];
  feedback: Feedback[]; rounds: DiscoveryRound[]; selectedProductId: string | null;
  /** Present after the Buy stage starts looking for more sellers of the chosen product. */
  sellerSearch?: SellerSearch | null;
}
/** The seller search belonging to a product, if one has been started. */
export function sellerSearchFor(session: ShoppingSession, productId: string | null | undefined): SellerSearch | null {
  const search = session.sellerSearch;
  return search && productId && search.productId === productId ? search : null;
}
const PRICE_ATTRIBUTES = new Set(['price', 'budget', 'budgetmax']);

export function constraintsFor(config: ShoppingConfig): Constraint[] {
  const constraints: Constraint[] = config.requirements.map((r, i) => {
    const attribute = r.attribute ?? `${UNINTERPRETED_PREFIX}${i}`;
    // The model may express a price floor as attribute="price" in major units.
    // Offers expose the seller's final listed price through the `total`
    // pseudo-attribute in minor units, so normalize it here. A `total`
    // requirement from Learn is already in minor units and is left untouched.
    if (PRICE_ATTRIBUTES.has(attribute.toLowerCase()) && typeof r.value === 'number') {
      return { attribute: TOTAL_ATTRIBUTE, op: r.op ?? '=', value: Math.round(r.value * 100), hard: r.hard };
    }
    return { attribute, op: r.op ?? '=', value: r.value ?? r.label, hard: r.hard };
  });
  if (config.budgetMax !== null) constraints.unshift({ attribute: TOTAL_ATTRIBUTE, op: '<=', value: Math.round(config.budgetMax * 100), hard: config.budgetHard });
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
/** The minimum brief fields a search still needs, in plain words. */
export function missingForSearch(config: ShoppingConfig): string[] {
  return [
    ...(config.category?.trim() ? [] : ['product category']),
    ...(config.purpose?.trim() ? [] : ['intended use']),
    ...(config.country ? [] : ['country']),
  ];
}
/** Ask replies after which Configure opens whenever the minimum brief exists, whatever the model says. */
export const ASK_QUESTION_CAP = 3;
export function askRounds(session: Pick<ShoppingSession, 'askMessages'>) { return session.askMessages.filter(m => m.role === 'assistant').length; }
export function rankProducts(products: Product[], context: DiscoveryContext): ComparisonResult {
  const config = effectiveConfig(context);
  const result = rankOffers({
    offers: products.flatMap(p => p.offers), constraints: constraintsFor(config), currency: config.currency, country: config.country,
    spec: { id: config.category ?? 'products', attributes: config.requirements.filter(r => r.attribute).map(r => ({ key: r.attribute!, unit: r.unit ?? undefined })) },
  });
  // A foreign currency is allowed, but it silently excludes every local price.
  const local = config.country ? currencyForCountry(config.country) : null;
  if (local && local !== config.currency) {
    result.warnings.unshift(`Prices must be in ${config.currency}, but sellers in ${config.country} usually list in ${local}. Switch the currency to ${local} to compare local offers.`);
  }
  return result;
}
export type RoundOutcome = 'found' | 'nothing_retrieved' | 'nothing_grounded' | 'all_excluded';
/**
 * Separates "not found" from "found but rejected" for a finished round:
 * no pages at all, pages without a verifiable offer, or offers that all failed a check.
 */
export function roundOutcome(round: Pick<DiscoveryRound, 'products' | 'sources' | 'ranking'>): RoundOutcome {
  if (round.ranking?.ranked.length) return 'found';
  if (round.products.length) return 'all_excluded';
  return round.sources.length ? 'nothing_grounded' : 'nothing_retrieved';
}
/**
 * Rankings are derived data, but session snapshots store them. Recompute them so a
 * stored session always follows the current ranking version and response shape.
 */
export function withCurrentRankings(session: ShoppingSession): ShoppingSession {
  return { ...session, rounds: session.rounds.map(round => round.ranking ? { ...round, ranking: rankProducts(round.products, round.context) } : round) };
}
export function allProducts(session: ShoppingSession): Product[] {
  return [...new Map(session.rounds.flatMap(r => r.products).map(p => [p.id, p])).values()];
}
export function latestRound(session: ShoppingSession) { return session.rounds.at(-1); }
export function activeProducts(session: ShoppingSession) {
  const discarded = new Set(session.feedback.map(f => f.productId));
  return (latestRound(session)?.products ?? []).filter(p => !discarded.has(p.id));
}
