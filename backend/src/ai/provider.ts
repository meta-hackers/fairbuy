import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DISCOVERY_MIN_PRODUCTS, OfferSchema, effectiveConfig, rankProducts, sourcePlan, isNonSellerHost, isPlannedSellerHost, type ChatMessage, type DiscoveryContext, type Product, type ShoppingConfig, type Source, type SourcePlan, type AttrValue, type Field } from '@fairbuy/core';
import type { Settings } from '../settings';
import { AppError } from '../errors';
import { safeImageUrl, safeUrl } from '../links';
import { logger } from '../logger';
import { DEFAULT_CATALOG_LOADER, type SourceCatalogLoader } from '../source-catalog';
import { MetaClient, type Research } from './meta';
import { ConversationResultSchema, ExtractionSchema, LearnedResultSchema, type Extraction } from './schemas';
import { ASK_PROMPT, CONFIGURE_PROMPT, DISCOVERY_PROMPT, EXTRACT_PROMPT, LEARN_PROMPT } from './prompts';
import { streamObjectArray } from './json-stream';
import { recordUsage } from '../usage';
import { findSellerImage } from '../product-images';

export type ConversationResult = z.infer<typeof ConversationResultSchema>;
export type LearnedResult = z.infer<typeof LearnedResultSchema>;
export interface DiscoveryResult { products: Product[]; sources: Source[]; summary: string }
export type DiscoveryProgress = (result: DiscoveryResult) => Promise<void>;
interface BraveItem { title: string; url: string; description: string; extra_snippets?: string[] }

// Brave plans are rate-limited per second (the free plan allows one request).
// Serialize calls in-process so concurrent discovery jobs cannot trip the limit,
// and leave a small margin for clock/network jitter.
let braveQueue: Promise<void> = Promise.resolve();
let braveNextRequestAt = 0;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function braveThrottle(minIntervalMs: number): Promise<void> {
  if (minIntervalMs <= 0) return Promise.resolve();
  const run = braveQueue.then(async () => {
    const wait = braveNextRequestAt - Date.now();
    if (wait > 0) await sleep(wait);
    braveNextRequestAt = Date.now() + minIntervalMs;
  });
  braveQueue = run.catch(() => undefined);
  return run;
}
// A discovery round has a hard wall-clock limit. It is not an acceptance
// threshold: when it is reached, in-flight provider calls are aborted, no new
// research pass starts, and any grounded products already found are kept.
export const DISCOVERY_TIMEOUT_MS = 5 * 60 * 1000;
export function discoveryPolicy(pass: number, elapsedMs: number) {
  const minimumSoftMatch = Math.max(0, 0.75 * (1 - Math.max(0, elapsedMs) / 90000));
  return {
    elapsedSeconds: Math.floor(elapsedMs / 1000),
    minimumSoftMatch,
    matchStrategy: elapsedMs >= 90000 ? 'best_available' : elapsedMs >= 45000 ? 'broader' : pass === 0 ? 'quick_start' : 'focused',
    researchTarget: pass === 0 ? 1 : DISCOVERY_MIN_PRODUCTS,
  };
}
export function acceptableProductCount(result: DiscoveryResult, context: DiscoveryContext, elapsedMs: number) {
  const threshold = discoveryPolicy(0, elapsedMs).minimumSoftMatch;
  const acceptable = new Set(rankProducts(result.products, context).ranked.filter(offer => {
    const soft = offer.constraints.filter(c => !c.constraint.hard);
    return !soft.length || soft.filter(c => c.outcome === 'pass').length / soft.length >= threshold;
  }).map(offer => offer.offerId));
  return result.products.filter(product => product.offers.some(offer => acceptable.has(offer.id))).length;
}
export interface AIProvider {
  ensureConfigured(): void;
  converse(phase: 'ask' | 'configure', messages: ChatMessage[], config: ShoppingConfig): Promise<ConversationResult>;
  learn(context: DiscoveryContext, reason: string, product: Product | null): Promise<LearnedResult>;
  discover(context: DiscoveryContext, onProgress?: DiscoveryProgress): Promise<DiscoveryResult>;
}
export function mergeDiscoveryResults(current: DiscoveryResult, incoming: DiscoveryResult): DiscoveryResult {
  const products = new Map(current.products.map(p => [p.id, p]));
  for (const product of incoming.products) {
    const existing = products.get(product.id);
    products.set(product.id, { ...product, imageUrl: product.imageUrl ?? existing?.imageUrl ?? null, offers: [...new Map([...(existing?.offers ?? []), ...product.offers].map(o => [o.id, o])).values()] });
  }
  return {
    products: [...products.values()], sources: [...new Map([...current.sources, ...incoming.sources].map(s => [s.url, s])).values()],
    summary: incoming.summary || current.summary,
  };
}
export function productId(name: string) {
  return createHash('sha256').update(name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')).digest('hex').slice(0, 20);
}
export function normalizeExtraction(extracted: Extraction, research: Research, context: DiscoveryContext, plan = sourcePlan(effectiveConfig(context))): DiscoveryResult {
  const allowed = new Set(research.sources.map(s => s.url));
  const sourceUrls = [...allowed];
  const discarded = new Set(context.discardedProducts.map(p => p.id));
  const now = new Date().toISOString();
  let rejected = 0, rejectedImages = 0, rejectedNonSeller = 0;
  const products = extracted.products.flatMap(raw => {
    const id = productId(raw.name);
    if (discarded.has(id)) return [];
    const imageUrl = safeImageUrl(raw.imageUrl, sourceUrls);
    if (raw.imageUrl && !imageUrl) rejectedImages++;
    const offers = raw.offers.flatMap(rawOffer => {
      const url = safeUrl(rawOffer.url);
      if (!url || !allowed.has(url) || !rawOffer.quote.trim() || !research.text.includes(rawOffer.quote)) { rejected++; return []; }
      if (isNonSellerHost(url, plan)) { rejectedNonSeller++; return []; }
      const evidence = [{ sourceType: 'url' as const, ref: url, snippet: rawOffer.quote, at: now }];
      const attributes: Record<string, Field<AttrValue>> = {};
      for (const attr of rawOffer.attributes) {
        if (!attr.quote.trim() || !research.text.includes(attr.quote)) continue;
        const value: AttrValue | null = attr.number !== null ? { kind: 'number', value: attr.number, unit: attr.unit ?? '' }
          : attr.boolean !== null ? { kind: 'bool', value: attr.boolean }
          : attr.text !== null ? { kind: 'text', value: attr.text } : null;
        if (value) attributes[attr.key] = { status: 'seller_claim', value, evidence: [{ ...evidence[0], snippet: attr.quote }] };
      }
      const missing = [...new Set([
        ...rawOffer.missing,
        ...(rawOffer.price === null ? ['Final listed price'] : []),
        ...(rawOffer.availability === 'unknown' ? ['Availability'] : []),
      ])];
      const offer = OfferSchema.parse({
        schemaVersion: 1, id: createHash('sha256').update(url).digest('hex').slice(0, 20),
        category: context.config.category ?? 'products', mode: 'live', provenanceUrl: url,
        fetchedAt: now, title: raw.name, seller: rawOffer.seller, availability: rawOffer.availability,
        condition: rawOffer.condition === 'unknown' ? { status: 'unknown' } : { status: 'seller_claim', value: rawOffer.condition, evidence },
        price: { currency: rawOffer.currency, amountCents: rawOffer.price === null ? null : Math.round(rawOffer.price * 100) },
        attributes, missing, evidence,
      });
      return [offer];
    });
    return offers.length ? [{ id, name: raw.name, summary: raw.summary, why: raw.why, tradeoffs: raw.tradeoffs, imageUrl, offers }] : [];
  });
  // A duplicated model/offer cannot crowd the shortlist.
  const unique = new Map<string, Product>();
  for (const product of products) {
    const existing = unique.get(product.id);
    if (existing) existing.offers = [...new Map([...existing.offers, ...product.offers].map(o => [o.id, o])).values()];
    else unique.set(product.id, product);
  }
  return {
    products: [...unique.values()], sources: research.sources,
    summary: `${extracted.summary}${rejected ? ` ${rejected} offer(s) were rejected because their URL or evidence could not be grounded in this search.` : ''}${rejectedImages ? ` ${rejectedImages} image(s) were rejected because they were not hosted on a returned official source.` : ''}${rejectedNonSeller ? ` ${rejectedNonSeller} offer(s) were rejected because a specification, review or comparison page is not a seller.` : ''}`,
  };
}

export class LiveAIProvider implements AIProvider {
  private client: MetaClient;
  constructor(private config: Settings, private fetcher: typeof fetch = fetch,
    private imageFinder: (product: Product, preferredImage: string | null, signal?: AbortSignal) => Promise<string | null> = findSellerImage,
    private catalog: SourceCatalogLoader = DEFAULT_CATALOG_LOADER) { this.client = new MetaClient(config, fetcher); }
  ensureConfigured() { this.client.ensureConfigured(); }
  async converse(phase: 'ask' | 'configure', messages: ChatMessage[], config: ShoppingConfig) {
    return this.client.structured(
      phase === 'ask' ? this.config.ASK_MODEL : this.config.CONFIGURE_MODEL,
      phase === 'ask' ? ASK_PROMPT : CONFIGURE_PROMPT, { phase, currentConfig: config, conversation: messages }, ConversationResultSchema,
      { reasoning: { effort: phase === 'ask' ? this.config.ASK_REASONING_EFFORT : this.config.CONFIGURE_REASONING_EFFORT } },
    );
  }
  async learn(context: DiscoveryContext, reason: string, product: Product | null) {
    return this.client.structured(this.config.CONFIGURE_MODEL, LEARN_PROMPT, { context, feedback: reason, product }, LearnedResultSchema, {
      reasoning: { effort: this.config.CONFIGURE_REASONING_EFFORT },
    });
  }
  async discover(context: DiscoveryContext, onProgress?: DiscoveryProgress) {
    let result: DiscoveryResult = { products: [], sources: [], summary: '' };
    const controller = new AbortController();
    const images = new Map<string, Promise<string | null>>();
    const resolvedImages = new Map<string, string>();
    let emitting: Promise<void> = Promise.resolve();
    // Serialise progress notifications: image fetches can finish while a
    // research/extraction update is being persisted.
    const emit = () => {
      emitting = emitting.then(() => onProgress?.(result)).catch(() => undefined);
      return emitting;
    };
    const applyImages = () => {
      let changed = false;
      for (const product of result.products) {
        const image = resolvedImages.get(product.id);
        if (image && image !== product.imageUrl) { product.imageUrl = image; changed = true; }
      }
      return changed;
    };
    const startImage = (product: Product) => {
      if (images.has(product.id)) return;
      const pending = this.imageFinder(product, product.imageUrl, controller.signal).then(image => {
        if (image) {
          resolvedImages.set(product.id, image);
          if (applyImages()) void emit();
        }
        return image;
      }).catch(() => null);
      images.set(product.id, pending);
    };
    const started = Date.now();
    const deadline = started + DISCOVERY_TIMEOUT_MS;
    const timeout = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
    timeout.unref();
    let timedOut = false;
    const roundId = context.discoverySessionId;
    const eligibleCount = () => {
      const ranked = new Set(rankProducts(result.products, context).ranked.map(r => r.offerId));
      return result.products.filter(p => p.offers.some(o => ranked.has(o.id))).length;
    };
    const config = effectiveConfig(context);
    let plan = sourcePlan(config);
    try { plan = sourcePlan(config, await this.catalog.effective()); }
    catch (error) { logger.error('discovery.source_catalog.failed', { roundId, error: error instanceof Error ? error.name : 'unknown' }); }
    logger.info('discovery.run.started', {
      roundId, provider: this.config.SEARCH_PROVIDER, previousProducts: context.previousProducts.length,
      discardedProducts: context.discardedProducts.length, feedback: context.feedback.length,
      vertical: plan.vertical, plannedSellers: plan.sellers.length, plannedSpecs: plan.specs.length,
      timeoutMs: DISCOVERY_TIMEOUT_MS,
    });
    try {
      // Bounded complementary searches, not retries of failed provider requests.
      for (let pass = 0; pass < 3 && acceptableProductCount(result, context, Date.now() - started) < DISCOVERY_MIN_PRODUCTS; pass++) {
        if (controller.signal.aborted || Date.now() >= deadline) { timedOut = true; break; }
        const passStarted = Date.now();
        const searchPolicy = discoveryPolicy(pass, passStarted - started);
        const input = {
          ...context, effectiveConfig: config, sourcePlan: plan, searchPass: pass + 1,
          minimumProducts: DISCOVERY_MIN_PRODUCTS, productsNeeded: DISCOVERY_MIN_PRODUCTS - acceptableProductCount(result, context, passStarted - started),
          alreadyFound: result.products, excludedOffers: rankProducts(result.products, context).excluded,
          searchPolicy,
        };
        logger.info('discovery.pass.started', {
          roundId, pass: pass + 1, eligible: eligibleCount(), needed: input.productsNeeded,
          vertical: plan.vertical, plannedSellers: plan.sellers.length, ...searchPolicy,
        });
        let research: Research;
        try {
          research = this.config.SEARCH_PROVIDER === 'brave' ? await this.braveResearch(context, result.products, pass, plan, controller.signal)
            : await this.client.research(this.config.DISCOVERY_MODEL, DISCOVERY_PROMPT, input, controller.signal);
        } catch (error) {
          if (controller.signal.aborted || Date.now() >= deadline) { timedOut = true; break; }
          throw error;
        }
        logger.info('discovery.research.completed', {
          roundId, pass: pass + 1, durationMs: Date.now() - passStarted,
          sources: research.sources.length, researchChars: research.text.length,
        });
        if (!research.sources.length) {
          logger.warn('discovery.research.empty', { roundId, pass: pass + 1, durationMs: Date.now() - passStarted });
          continue;
        }
        const accept = async (incoming: DiscoveryResult) => {
          for (const product of incoming.products) startImage(product);
          result = mergeDiscoveryResults(result, incoming);
          applyImages();
          await emit();
        };
        const streamed = new Set<string>();
        const onText = streamObjectArray('products', async raw => {
          const parsed = ExtractionSchema.shape.products.element.safeParse(raw);
          if (!parsed.success) return;
          const grounded = normalizeExtraction({ summary: '', products: [parsed.data] }, research, context, plan);
          if (grounded.products.length) {
            grounded.products.forEach(p => streamed.add(p.id));
            logger.info('discovery.product.streamed', {
              roundId, pass: pass + 1, productId: grounded.products[0].id, offers: grounded.products[0].offers.length,
              vertical: plan.vertical,
              plannedSeller: grounded.products[0].offers.some(offer => isPlannedSellerHost(offer.provenanceUrl, plan)),
            });
            await accept(grounded);
          }
        });
        const extractionStarted = Date.now();
        let extracted: z.infer<typeof ExtractionSchema>;
        try {
          extracted = await this.client.structured(this.config.DISCOVERY_MODEL, EXTRACT_PROMPT, { context: input, research }, ExtractionSchema, {
            // Extraction is mechanical: spend fewer tokens reasoning and more on the JSON result.
            max_output_tokens: 16000, reasoning: { effort: 'low' },
          }, onText, controller.signal);
        } catch (error) {
          // Keep products streamed before the deadline; they were already persisted by accept().
          if (controller.signal.aborted || Date.now() >= deadline) { timedOut = true; break; }
          throw error;
        }
        // Also handles providers that send only a terminal event, and commits the final summary.
        const grounded = normalizeExtraction(extracted, research, context, plan);
        logger.info('discovery.extraction.completed', {
          roundId, pass: pass + 1, durationMs: Date.now() - extractionStarted,
          extractedProducts: extracted.products.length, acceptedProducts: grounded.products.length,
        });
        for (const product of grounded.products) if (!streamed.has(product.id)) await accept({ products: [product], sources: grounded.sources, summary: '' });
        await accept({ products: [], sources: grounded.sources, summary: grounded.summary });
        logger.info('discovery.pass.completed', { roundId, pass: pass + 1, durationMs: Date.now() - passStarted, eligible: eligibleCount() });
      }
      // Apply images that finished while research was running. The final wait is
      // bounded by the discovery signal, so a slow seller cannot extend the
      // round past its hard limit, and resolved images are never discarded.
      applyImages();
      await Promise.all([...images.values()]);
      applyImages();
      await emitting;
    } finally { clearTimeout(timeout); }
    if (controller.signal.aborted) timedOut = true;
    const count = eligibleCount();
    if (count < DISCOVERY_MIN_PRODUCTS) result.summary = `${result.summary}${result.summary ? ' ' : ''}Only ${count} distinct eligible product${count === 1 ? '' : 's'} could be grounded after additional searches. We could not reach ${DISCOVERY_MIN_PRODUCTS} without breaking your must-haves or inventing offers.`;
    if (timedOut) result.summary = `${result.summary}${result.summary ? ' ' : ''}Search stopped at the 5-minute limit; the products already found are kept.`;
    logger.info('discovery.run.completed', { roundId, durationMs: Date.now() - started, products: result.products.length, eligible: count, sources: result.sources.length, timedOut });
    return result;
  }
  private async braveResearch(context: DiscoveryContext, alreadyFound: Product[], pass: number, plan: SourcePlan, signal?: AbortSignal): Promise<Research> {
    const configuredAt = Date.now();
    try { this.ensureConfigured(); }
    catch (error) { recordUsage('brave', 'web-search', 'search', 'failed', Date.now() - configuredAt); throw error; }
    const config = effectiveConfig(context);
    const queries = this.braveQueries(config, plan, pass, alreadyFound);
    const pages: { query: string; items: BraveItem[] }[] = [];
    const failures: unknown[] = [];
    // Sequential calls respect the provider's per-second limit. A failed query
    // must not discard results from the queries that did run.
    for (const query of queries) {
      if (signal?.aborted) break;
      try { pages.push({ query, items: (await this.braveSearchTracked(query, signal)).items }); }
      catch (error) { failures.push(error); }
    }
    logger.info('discovery.brave.queries', {
      roundId: context.discoverySessionId, pass: pass + 1, queries: queries.length,
      completed: pages.length, failed: failures.length, timedOut: !!signal?.aborted,
    });
    if (!pages.length) {
      if (signal?.aborted) throw new AppError(504, 'The search reached its 5-minute limit.', 'SEARCH_TIME_LIMIT');
      const failure = failures[0];
      throw failure instanceof Error ? failure : new AppError(502, 'Brave search failed. Please retry.', 'SEARCH_PROVIDER_ERROR');
    }
    const items = [...new Map(pages.flatMap(page => page.items).map(item => [item.url, item])).values()];
    return {
      text: pages.map(page => `Brave search snippets only; full pages not fetched. Query: ${page.query}\n` +
        page.items.map(r => `${r.title}\n${r.url}\n${r.description}\n${r.extra_snippets?.join('\n') ?? ''}`).join('\n\n')).join('\n\n').slice(0, 40000),
      sources: items.map(r => ({ url: r.url, title: r.title })),
    };
  }
  /**
   * One concise broad query plus a rotating slice of curated seller domains.
   * Each pass covers a different third of the seller plan, so a category with
   * eight sellers still searches domains such as iwc.com instead of repeatedly
   * querying only the first four. The first broad query includes soft
   * preferences to anchor the search; later passes keep only hard constraints
   * so they can broaden. All preferences still participate in ranking.
   */
  private braveQueries(config: ShoppingConfig, plan: SourcePlan, pass: number, alreadyFound: Product[]): string[] {
    const hardLabels = config.requirements.filter(r => r.hard).map(r => r.label);
    // The first broad query may include soft preferences to anchor the search.
    // Later passes keep only must-haves so they can broaden usefully.
    const broadLabels = config.requirements.filter(r => r.hard || pass === 0).map(r => r.label);
    const priceHint = this.bravePriceHint(config, pass);
    const base = [config.category, config.purpose, config.country, config.city, config.currency, ...broadLabels, priceHint]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join(' ');
    const alternatives = pass > 0 && alreadyFound.length
      ? `alternative models ${alreadyFound.slice(0, 4).map(p => `-"${p.name}"`).join(' ')}`
      : '';
    const broad = [base, alternatives, 'buy price'].filter(Boolean).join(' ').slice(0, 300);
    const sellers = plan.vertical !== 'general' && plan.sellers.length
      ? plan.sellers.filter((_, index) => index % 3 === pass % 3).slice(0, 3)
      : [];
    const targeted = sellers.map(source => [config.category, config.purpose, config.country, config.city, config.currency,
      `site:${source.domain}`, ...hardLabels, 'buy price']
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join(' ').slice(0, 300));
    return [broad, ...targeted];
  }
  private bravePriceHint(config: ShoppingConfig, pass: number): string {
    // Hard budgets always constrain the search. A soft budget is useful on the
    // first pass (to anchor the result) but should not filter later broadening.
    if (config.budgetMax !== null && (config.budgetHard || pass === 0)) return `under ${config.budgetMax} ${config.currency}`;
    const price = config.requirements.find(r => /^(price|total|budget|budgetmax)$/i.test(r.attribute ?? '') || /\b(price|budget)\b/i.test(r.label));
    return price?.label ?? '';
  }
  private async braveSearchTracked(query: string, signal?: AbortSignal) {
    const started = Date.now();
    let status = 'failed';
    try {
      const result = await this.braveSearch(query, 0, signal);
      status = 'completed';
      return result;
    } finally { recordUsage('brave', 'web-search', 'search', status, Date.now() - started); }
  }
  private async braveSearch(query: string, attempt = 0, signal?: AbortSignal): Promise<{ items: BraveItem[] }> {
    if (signal?.aborted) throw new AppError(504, 'The search reached its 5-minute limit.', 'SEARCH_TIME_LIMIT');
    await braveThrottle(this.config.BRAVE_MIN_INTERVAL_MS);
    if (signal?.aborted) throw new AppError(504, 'The search reached its 5-minute limit.', 'SEARCH_TIME_LIMIT');
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query); url.searchParams.set('count', '15'); url.searchParams.set('extra_snippets', 'true');
    let response: Response;
    const timeout = AbortSignal.timeout(20000);
    try {
      response = await this.fetcher(url, { headers: { 'X-Subscription-Token': this.config.BRAVE_API_KEY, Accept: 'application/json' }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error' });
    } catch {
      if (signal?.aborted) throw new AppError(504, 'The search reached its 5-minute limit.', 'SEARCH_TIME_LIMIT');
      throw new AppError(502, 'Brave search could not be reached. Please retry.', 'SEARCH_UNREACHABLE');
    }
    if (response.status === 429 && attempt === 0) {
      await response.body?.cancel();
      // Retry once after the documented one-request-per-second window. The
      // throttle will also wait if another query is already queued.
      logger.warn('discovery.brave.rate_limited', { retryInMs: Math.max(1100, this.config.BRAVE_MIN_INTERVAL_MS) });
      await sleep(Math.max(1100, this.config.BRAVE_MIN_INTERVAL_MS));
      return this.braveSearch(query, 1, signal);
    }
    if (!response.ok) { await response.body?.cancel(); throw new AppError(502, 'Brave search rejected the request. Check your search API key, credit and limits.', 'SEARCH_PROVIDER_ERROR'); }
    const schema = z.object({ web: z.object({ results: z.array(z.object({ title: z.string(), url: z.string(), description: z.string(), extra_snippets: z.array(z.string()).optional() })) }).optional() });
    let results: z.infer<typeof schema>;
    try { results = schema.parse(await response.json()); }
    catch { throw new AppError(502, 'Brave returned invalid search data.', 'SEARCH_INVALID_DATA'); }
    const items = (results.web?.results ?? []).flatMap(r => { const safe = safeUrl(r.url); return safe ? [{ ...r, url: safe }] : []; });
    return { items };
  }
}
