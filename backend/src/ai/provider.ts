import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CURRENCIES, DISCOVERY_MIN_PRODUCTS, MAX_DROPPED, UNINTERPRETED_PREFIX, OfferSchema, hostOf, effectiveConfig, rankProducts, sourcePlan, sellerMarketFor, sellerMarkets, isNonSellerHost, isPlannedSellerHost, type ChatMessage, type DropReason, type DroppedOffer, type Currency, type DiscoveryContext, type Offer, type Product, type SellerMarkets, type ShoppingConfig, type Source, type SourcePlan, type AttrValue, type Field } from '@fairbuy/core';
import type { Settings } from '../settings';
import { AppError } from '../errors';
import { safeImageUrl, safeUrl } from '../links';
import { logger } from '../logger';
import { EMPTY_CATALOG_LOADER, type SourceCatalogLoader } from '../source-catalog';
import { MetaClient, type Research } from './meta';
import { ConversationResultSchema, ExtractionSchema, LearnedResultSchema, SellerExtractionSchema, type Extraction } from './schemas';
import { ASK_PROMPT, CONFIGURE_PROMPT, DISCOVERY_PROMPT, EXTRACT_PROMPT, LEARN_PROMPT, SELLER_EXTRACT_PROMPT, SELLER_SEARCH_PROMPT } from './prompts';
import { streamObjectArray } from './json-stream';
import { recordUsage } from '../usage';
import { decodeHtmlEntities, findSellerImage, isGenericImageUrl } from '../product-images';
import { traceProductImage } from '../diagnostics';

export type ConversationResult = z.infer<typeof ConversationResultSchema>;
export type LearnedResult = z.infer<typeof LearnedResultSchema>;
export interface DiscoveryResult { products: Product[]; sources: Source[]; summary: string; dropped?: DroppedOffer[] }
export type DiscoveryProgress = (result: DiscoveryResult) => Promise<void>;
export type DiscoveryActivityProgress = (message: string) => Promise<void>;
export interface SellerSearchResult { offers: Offer[]; sources: Source[]; summary: string; dropped?: DroppedOffer[] }
export type SellerSearchProgress = (result: SellerSearchResult) => Promise<void>;
export const SELLER_SEARCH_TIMEOUT_MS = 2 * 60 * 1000;
export const MAX_SELLER_OFFERS = 8;
interface BraveThumbnail { src?: string | null; original?: string | null; logo?: boolean | null }
interface BraveItem { title: string; url: string; description: string; extra_snippets?: string[]; thumbnail?: BraveThumbnail | null }

/**
 * Brave exposes the page's own product thumbnail. Use it when the seller page
 * blocks our HTML fetch: the seller/CDN image itself is usually still public.
 * Logos and generic site furniture are ignored.
 */
function searchThumbnail(item: BraveItem): string | null {
  if (item.thumbnail?.logo) return null;
  if (item.thumbnail?.original) {
    const image = safeImageUrl(decodeHtmlEntities(item.thumbnail.original), [item.url]);
    // A generic original is generic whichever proxy serves it; do not retry it.
    if (image) return isGenericImageUrl(image) ? null : image;
  }
  if (item.thumbnail?.src) {
    const image = safeImageUrl(decodeHtmlEntities(item.thumbnail.src), [item.url]);
    if (image && !isGenericImageUrl(image)) return image;
  }
  return null;
}
function thumbnailImages(items: BraveItem[]): Record<string, string> {
  const images: Record<string, string> = {};
  for (const item of items) {
    const image = searchThumbnail(item);
    if (image) images[item.url] = image;
  }
  return images;
}
/** Never send image bookkeeping to the model; it only needs the evidence text. */
const promptResearch = (research: Research) => ({ text: research.text, sources: research.sources });

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
    // Free-text requirements have no machine-checkable attribute. Keep their
    // unknown outcome in ranking/evidence, but do not let them force extra
    // searches. Structured preferences with missing evidence still count.
    const soft = offer.constraints.filter(c => !c.constraint.hard && !c.constraint.attribute.startsWith(UNINTERPRETED_PREFIX));
    return !soft.length || soft.filter(c => c.outcome === 'pass').length / soft.length >= threshold;
  }).map(offer => offer.offerId));
  return result.products.filter(product => product.offers.some(offer => acceptable.has(offer.id))).length;
}
export interface AIProvider {
  ensureConfigured(): void;
  converse(phase: 'ask' | 'configure', messages: ChatMessage[], config: ShoppingConfig): Promise<ConversationResult>;
  learn(context: DiscoveryContext, reason: string, product: Product | null): Promise<LearnedResult>;
  discover(context: DiscoveryContext, onProgress?: DiscoveryProgress, onActivity?: DiscoveryActivityProgress): Promise<DiscoveryResult>;
  findSellers(context: DiscoveryContext, product: Product, onProgress?: SellerSearchProgress, onActivity?: DiscoveryActivityProgress): Promise<SellerSearchResult>;
}
export function mergeDiscoveryResults(current: DiscoveryResult, incoming: DiscoveryResult): DiscoveryResult {
  const products = new Map(current.products.map(p => [p.id, p]));
  for (const product of incoming.products) {
    const existing = products.get(product.id);
    products.set(product.id, { ...product, imageUrl: product.imageUrl ?? existing?.imageUrl ?? null, offers: [...new Map([...(existing?.offers ?? []), ...product.offers].map(o => [o.id, o])).values()] });
  }
  // Passes report the same drop again when they meet the same page; keep each once.
  const dropped = [...new Map([...current.dropped ?? [], ...incoming.dropped ?? []]
    .map(d => [`${d.reason}|${d.product}|${d.seller}|${d.host}`, d])).values()].slice(0, MAX_DROPPED);
  return {
    products: [...products.values()], sources: [...new Map([...current.sources, ...incoming.sources].map(s => [s.url, s])).values()],
    summary: incoming.summary || current.summary, dropped,
  };
}
export function mergeSellerSearchResults(current: SellerSearchResult, incoming: SellerSearchResult): SellerSearchResult {
  const offers = new Map(current.offers.map(offer => [offer.id, offer]));
  for (const offer of incoming.offers) {
    // Progress may stream the same seller before the final extraction does.
    // Keep one card per seller, preferring the latest grounded page.
    const duplicate = [...offers.values()].find(existing => existing.id === offer.id || sellerName(existing.seller) === sellerName(offer.seller));
    if (duplicate && duplicate.id !== offer.id) offers.delete(duplicate.id);
    offers.set(offer.id, offer);
  }
  const dropped = [...new Map([...current.dropped ?? [], ...incoming.dropped ?? []]
    .map(drop => [`${drop.reason}|${drop.product}|${drop.seller}|${drop.host}`, drop])).values()].slice(0, MAX_DROPPED);
  return {
    offers: [...offers.values()].slice(0, MAX_SELLER_OFFERS),
    sources: [...new Map([...current.sources, ...incoming.sources].map(source => [source.url, source])).values()],
    summary: incoming.summary || current.summary,
    dropped,
  };
}
function sellerName(value: string) {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
/**
 * Grounds Buy-stage seller offers with the same URL/quote checks as discovery,
 * then keeps only additional sellers of the chosen model in the same market.
 * Deliberately does not rank or re-check the brief's preferences.
 */
export function normalizeSellerOffers(
  rawOffers: Extraction['products'][number]['offers'], research: Research, context: DiscoveryContext,
  product: Product, plan = sourcePlan(effectiveConfig(context)), markets: SellerMarkets = {},
): SellerSearchResult {
  const knownIds = new Set(product.offers.map(offer => offer.id));
  const knownSellers = new Set(product.offers.map(offer => sellerName(offer.seller)));
  const grounded = normalizeExtraction({
    summary: '', products: [{
      name: product.name, summary: '', why: '', tradeoffs: [], imageUrl: null, offers: rawOffers,
    }],
  }, research, context, plan, markets);
  const offers: Offer[] = [];
  let known = 0, wrongMarket = 0, duplicate = 0;
  for (const offer of grounded.products.flatMap(item => item.offers)) {
    if (knownIds.has(offer.id) || knownSellers.has(sellerName(offer.seller))) { known++; continue; }
    const market = offer.sellerMarket;
    if (context.config.country && market && market.countries !== 'global' && !market.countries.includes(context.config.country)) {
      wrongMarket++; continue;
    }
    if (offers.some(existing => existing.id === offer.id || sellerName(existing.seller) === sellerName(offer.seller))) { duplicate++; continue; }
    offers.push(offer);
  }
  const skipped = known || wrongMarket || duplicate
    ? ` Skipped ${[known && `${known} already-listed seller${known === 1 ? '' : 's'}`, wrongMarket && `${wrongMarket} from another market`, duplicate && `${duplicate} duplicate${duplicate === 1 ? '' : 's'}`].filter(Boolean).join(', ')}.`
    : '';
  return {
    offers, sources: research.sources, dropped: grounded.dropped,
    summary: `${offers.length} additional seller${offers.length === 1 ? '' : 's'} for ${product.name}.${skipped}`,
  };
}
export function productId(name: string) {
  return createHash('sha256').update(name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')).digest('hex').slice(0, 20);
}
// ISO codes that are also common uppercase words or brands ("ALL", "TOP", "AMD 7840").
const AMBIGUOUS_CURRENCY_CODES = new Set(['ALL', 'AMD', 'BAM', 'BOB', 'CUP', 'GEL', 'MAD', 'MOP', 'PEN', 'SOS', 'TOP', 'TRY']);
const CURRENCY_CODES = new Set<string>(CURRENCIES);
/** The one ISO currency code the quote attaches to an amount, if exactly one. */
export function quotedCurrency(quote: string): Currency | null {
  const codes = new Set([...quote.matchAll(/\b([A-Z]{3})\s?\d|\d[\d.,']*\s?([A-Z]{3})\b/g)]
    .map(match => match[1] ?? match[2])
    .filter(code => CURRENCY_CODES.has(code) && !AMBIGUOUS_CURRENCY_CODES.has(code)));
  return codes.size === 1 ? [...codes][0] as Currency : null;
}
export function normalizeExtraction(extracted: Extraction, research: Research, context: DiscoveryContext, plan = sourcePlan(effectiveConfig(context)), markets: SellerMarkets = {}): DiscoveryResult {
  const allowed = new Set(research.sources.map(s => s.url));
  const sourceUrls = [...allowed];
  const discarded = new Set(context.discardedProducts.map(p => p.id));
  const now = new Date().toISOString();
  let rejected = 0, rejectedImages = 0, rejectedNonSeller = 0;
  const dropped: DroppedOffer[] = [];
  const drop = (reason: DropReason, product: string, seller: string | null, url: string | null) =>
    dropped.push({ reason, product, seller, host: url ? hostOf(url) : null });
  const products = extracted.products.flatMap(raw => {
    const id = productId(raw.name);
    if (discarded.has(id)) { drop('previously_discarded', raw.name, null, null); return []; }
    const extractedImage = safeImageUrl(raw.imageUrl, sourceUrls);
    if (raw.imageUrl && !extractedImage) rejectedImages++;
    const offers = raw.offers.flatMap(rawOffer => {
      const url = safeUrl(rawOffer.url);
      if (!url || !allowed.has(url)) { rejected++; drop('url_not_in_sources', raw.name, rawOffer.seller, url); return []; }
      if (!rawOffer.quote.trim() || !research.text.includes(rawOffer.quote)) { rejected++; drop('quote_not_grounded', raw.name, rawOffer.seller, url); return []; }
      if (isNonSellerHost(url, plan)) { rejectedNonSeller++; drop('not_a_seller', raw.name, rawOffer.seller, url); return []; }
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
      const sellerMarket = sellerMarketFor(url, markets);
      const offer = OfferSchema.parse({
        schemaVersion: 1, id: createHash('sha256').update(url).digest('hex').slice(0, 20),
        category: context.config.category ?? 'products', mode: 'live', provenanceUrl: url,
        fetchedAt: now, title: raw.name, seller: rawOffer.seller, availability: rawOffer.availability,
        condition: rawOffer.condition === 'unknown' ? { status: 'unknown' } : { status: 'seller_claim', value: rawOffer.condition, evidence },
        // The quote is the price evidence, so its stated currency wins over the model's field.
        price: { currency: (rawOffer.price !== null && quotedCurrency(rawOffer.quote)) || rawOffer.currency, amountCents: rawOffer.price === null ? null : Math.round(rawOffer.price * 100) },
        attributes, missing, evidence,
        ...(sellerMarket ? { sellerMarket } : {}),
      });
      return [offer];
    });
    // When the model has no usable official image, fall back to the thumbnail
    // Brave returned for one of this product's grounded offer pages. This is
    // the listing's own image and works even when the page blocks scraping.
    const fallbackImage = offers.map(offer => research.images?.[offer.provenanceUrl]).find((image): image is string => !!image);
    const imageUrl = extractedImage ?? safeImageUrl(fallbackImage, sourceUrls);
    return offers.length ? [{ id, name: raw.name, summary: raw.summary, why: raw.why, tradeoffs: raw.tradeoffs, imageUrl, offers }] : [];
  });
  // A duplicated model/offer cannot crowd the shortlist.
  const unique = new Map<string, Product>();
  for (const product of products) {
    const existing = unique.get(product.id);
    if (existing) {
      existing.offers = [...new Map([...existing.offers, ...product.offers].map(o => [o.id, o])).values()];
      drop('duplicate', product.name, null, null);
    } else unique.set(product.id, product);
  }
  return {
    products: [...unique.values()], sources: research.sources, dropped: dropped.slice(0, MAX_DROPPED),
    summary: `${extracted.summary}${rejected ? ` ${rejected} offer(s) were rejected because their URL or evidence could not be grounded in this search.` : ''}${rejectedImages ? ` ${rejectedImages} image(s) were rejected because they were not hosted on a returned official source.` : ''}${rejectedNonSeller ? ` ${rejectedNonSeller} offer(s) were rejected because a specification, review or comparison page is not a seller.` : ''}`,
  };
}

export class LiveAIProvider implements AIProvider {
  private client: MetaClient;
  constructor(private config: Settings, private fetcher: typeof fetch = fetch,
    private imageFinder: (product: Product, preferredImage: string | null, signal?: AbortSignal) => Promise<string | null> = findSellerImage,
    private catalog: SourceCatalogLoader = EMPTY_CATALOG_LOADER) { this.client = new MetaClient(config, fetcher); }
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
  async discover(context: DiscoveryContext, onProgress?: DiscoveryProgress, onActivity?: DiscoveryActivityProgress) {
    let result: DiscoveryResult = { products: [], sources: [], summary: '' };
    // Activity contains only milestones we observe, never model reasoning or invented browsing.
    const activity = async (message: string) => { await onActivity?.(message); };
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
      const pending = traceProductImage(product.id, () => this.imageFinder(product, product.imageUrl, controller.signal)).then(image => {
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
    let passes = 0;
    let firstEligibleProductMs: number | null = null;
    const roundId = context.discoverySessionId;
    const eligibleCount = () => {
      const ranked = new Set(rankProducts(result.products, context).ranked.map(r => r.offerId));
      return result.products.filter(p => p.offers.some(o => ranked.has(o.id))).length;
    };
    const config = effectiveConfig(context);
    let plan = sourcePlan(config);
    let markets: SellerMarkets = {};
    try { const catalog = await this.catalog.effective(); plan = sourcePlan(config, catalog); markets = sellerMarkets(catalog); }
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
        passes++;
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
          await activity(pass === 0 ? 'Searching the web for products that match your brief.' : 'Searching for more alternatives while keeping your must-haves.');
          research = this.config.SEARCH_PROVIDER === 'brave' ? await this.braveResearch(context, result.products, pass, plan, controller.signal, activity)
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
          await activity('No sources returned by this search. Trying another search if time allows.');
          logger.warn('discovery.research.empty', { roundId, pass: pass + 1, durationMs: Date.now() - passStarted });
          continue;
        }
        const hosts = [...new Set(research.sources.map(source => hostOf(source.url)).filter(Boolean))];
        await activity(`Comparing search evidence from ${hosts.slice(0, 3).join(', ')}${hosts.length > 3 ? ` and ${hosts.length - 3} other sites` : ''} with your requirements.`);
        const accept = async (incoming: DiscoveryResult) => {
          for (const product of incoming.products) startImage(product);
          result = mergeDiscoveryResults(result, incoming);
          if (firstEligibleProductMs === null && eligibleCount() > 0) firstEligibleProductMs = Date.now() - started;
          applyImages();
          await emit();
        };
        const streamed = new Set<string>();
        const onText = streamObjectArray('products', async raw => {
          const parsed = ExtractionSchema.shape.products.element.safeParse(raw);
          if (!parsed.success) return;
          await activity(`Checking ${parsed.data.name} against your requirements and its source evidence.`);
          const grounded = normalizeExtraction({ summary: '', products: [parsed.data] }, research, context, plan, markets);
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
          extracted = await this.client.structured(this.config.DISCOVERY_MODEL, EXTRACT_PROMPT, { context: input, research: promptResearch(research) }, ExtractionSchema, {
            // Extraction is mechanical: spend fewer tokens reasoning and more on the JSON result.
            max_output_tokens: 16000, reasoning: { effort: 'low' },
          }, onText, controller.signal);
        } catch (error) {
          // Keep products streamed before the deadline; they were already persisted by accept().
          if (controller.signal.aborted || Date.now() >= deadline) { timedOut = true; break; }
          throw error;
        }
        // Also handles providers that send only a terminal event, and commits the final summary.
        const grounded = normalizeExtraction(extracted, research, context, plan, markets);
        logger.info('discovery.extraction.completed', {
          roundId, pass: pass + 1, durationMs: Date.now() - extractionStarted,
          extractedProducts: extracted.products.length, acceptedProducts: grounded.products.length,
        });
        for (const product of grounded.products) if (!streamed.has(product.id)) {
          await activity(`Checking ${product.name} against your requirements and its source evidence.`);
          await accept({ products: [product], sources: grounded.sources, summary: '' });
        }
        await accept({ products: [], sources: grounded.sources, summary: grounded.summary });
        logger.info('discovery.pass.completed', { roundId, pass: pass + 1, durationMs: Date.now() - passStarted, eligible: eligibleCount(), acceptable: acceptableProductCount(result, context, Date.now() - started) });
      }
      // Apply images that finished while research was running. The final wait is
      // bounded by the discovery signal, so a slow seller cannot extend the
      // round past its hard limit, and resolved images are never discarded.
      applyImages();
      if ([...images.keys()].some(id => !resolvedImages.has(id))) await activity('Finishing product image checks and preparing your shortlist.');
      await Promise.all([...images.values()]);
      applyImages();
      await emitting;
    } finally { clearTimeout(timeout); }
    if (controller.signal.aborted) timedOut = true;
    const count = eligibleCount();
    if (count < DISCOVERY_MIN_PRODUCTS) result.summary = `${result.summary}${result.summary ? ' ' : ''}Only ${count} distinct eligible product${count === 1 ? '' : 's'} could be grounded after additional searches. We could not reach ${DISCOVERY_MIN_PRODUCTS} without breaking your must-haves or inventing offers.`;
    if (timedOut) result.summary = `${result.summary}${result.summary ? ' ' : ''}Search stopped at the 5-minute limit; the products already found are kept.`;
    logger.info('discovery.run.completed', { roundId, durationMs: Date.now() - started, products: result.products.length, eligible: count, acceptable: acceptableProductCount(result, context, Date.now() - started), sources: result.sources.length, timedOut, passes, firstEligibleProductMs });
    return result;
  }
  /**
   * Buy-stage seller expansion: one strong search for the exact chosen model in
   * the same market. It intentionally does not rank offers or re-check the
   * brief's features; it only grounds additional sellers and their evidence.
   */
  async findSellers(context: DiscoveryContext, product: Product, onProgress?: SellerSearchProgress, onActivity?: DiscoveryActivityProgress) {
    this.ensureConfigured();
    const config = effectiveConfig(context);
    let plan = sourcePlan(config);
    let markets: SellerMarkets = {};
    try { const catalog = await this.catalog.effective(); plan = sourcePlan(config, catalog); markets = sellerMarkets(catalog); }
    catch (error) { logger.error('seller_search.source_catalog.failed', { sessionId: context.sessionId, error: error instanceof Error ? error.name : 'unknown' }); }
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SELLER_SEARCH_TIMEOUT_MS);
    timeout.unref();
    let result: SellerSearchResult = { offers: [], sources: [], summary: '' };
    const knownOffers = product.offers.map(offer => ({ seller: offer.seller, url: offer.provenanceUrl, price: offer.price }));
    const input = {
      product: { id: product.id, name: product.name, summary: product.summary, knownOffers },
      market: { country: config.country, city: config.city, currency: config.currency },
      sourcePlan: plan, knownOffers,
    };
    try {
      await onActivity?.(`Searching for other ${config.country ?? 'local'} sellers of ${product.name}.`);
      const research = this.config.SEARCH_PROVIDER === 'brave'
        ? await this.braveSellerResearch(product, config, plan, controller.signal, onActivity)
        : await this.client.research(this.config.SELLER_SEARCH_MODEL, SELLER_SEARCH_PROMPT, input, controller.signal, {
          searchContextSize: 'high', reasoningEffort: this.config.SELLER_SEARCH_REASONING_EFFORT,
        });
      logger.info('seller_search.research.completed', {
        sessionId: context.sessionId, productId: product.id, durationMs: Date.now() - started,
        sources: research.sources.length, researchChars: research.text.length, provider: this.config.SEARCH_PROVIDER,
        model: this.config.SELLER_SEARCH_MODEL, effort: this.config.SELLER_SEARCH_REASONING_EFFORT,
      });
      if (!research.sources.length) {
        result = { offers: [], sources: [], summary: `No additional seller pages were returned for ${product.name}.` };
        await onProgress?.(result);
        return result;
      }
      await onActivity?.(`Checking ${research.sources.length} ${research.sources.length === 1 ? 'page' : 'pages'} for the exact same model.`);
      const streamed = new Set<string>();
      const accept = async (incoming: SellerSearchResult) => {
        result = mergeSellerSearchResults(result, incoming);
        await onProgress?.(result);
      };
      const onText = streamObjectArray('offers', async raw => {
        const parsed = SellerExtractionSchema.shape.offers.element.safeParse(raw);
        if (!parsed.success) return;
        const grounded = normalizeSellerOffers([parsed.data], research, context, product, plan, markets);
        if (!grounded.offers.length) return;
        grounded.offers.forEach(offer => streamed.add(offer.id));
        await accept(grounded);
      });
      const extracted = await this.client.structured(this.config.SELLER_SEARCH_MODEL, SELLER_EXTRACT_PROMPT, { product: input.product, research: promptResearch(research), knownOffers }, SellerExtractionSchema, {
        max_output_tokens: 8000, reasoning: { effort: 'low' },
      }, onText, controller.signal);
      const grounded = normalizeSellerOffers(extracted.offers, research, context, product, plan, markets);
      const unseen = grounded.offers.filter(offer => !streamed.has(offer.id));
      await accept({
        offers: unseen, sources: research.sources,
        summary: `${extracted.summary}${extracted.summary ? ' ' : ''}${grounded.summary}`,
        dropped: grounded.dropped,
      });
      logger.info('seller_search.completed', {
        sessionId: context.sessionId, productId: product.id, durationMs: Date.now() - started,
        offers: result.offers.length, sources: result.sources.length,
      });
      return result;
    } catch (error) {
      if (controller.signal.aborted) {
        if (result.offers.length) {
          result.summary = `${result.summary}${result.summary ? ' ' : ''}Seller search stopped at the 2-minute limit; the offers already found are kept.`;
          await onProgress?.(result);
          return result;
        }
        throw new AppError(504, 'Seller search reached its time limit. Please retry.', 'SELLER_SEARCH_TIME_LIMIT');
      }
      throw error;
    } finally { clearTimeout(timeout); }
  }
  private async braveSellerResearch(product: Product, config: ShoppingConfig, plan: SourcePlan, signal?: AbortSignal, onActivity?: DiscoveryActivityProgress): Promise<Research> {
    this.ensureConfigured();
    const known = product.offers.slice(0, 6).map(offer => `-"${offer.seller}"`).join(' ');
    const base = [product.name, config.country, config.city, config.currency, 'buy price', known]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0).join(' ').slice(0, 300);
    const targeted = plan.vertical !== 'general' && plan.sellers.length
      ? plan.sellers.slice(0, 4).map(source => [product.name, config.country, `site:${source.domain}`, 'buy price']
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0).join(' ').slice(0, 300))
      : [];
    const queries = [base, ...targeted];
    const pages: { query: string; items: BraveItem[] }[] = [];
    const failures: unknown[] = [];
    for (const query of queries) {
      if (signal?.aborted) break;
      const domain = query.match(/\bsite:([\w.-]+)/)?.[1];
      await onActivity?.(domain ? `Checking ${domain} for another seller of the same model.` : 'Searching the same market for another seller.');
      try { pages.push({ query, items: (await this.braveSearchTracked(query, signal)).items }); }
      catch (error) { failures.push(error); }
    }
    if (!pages.length) {
      if (signal?.aborted) throw new AppError(504, 'The seller search reached its time limit.', 'SELLER_SEARCH_TIME_LIMIT');
      const failure = failures[0];
      throw failure instanceof Error ? failure : new AppError(502, 'Seller search failed. Please retry.', 'SEARCH_PROVIDER_ERROR');
    }
    const items = [...new Map(pages.flatMap(page => page.items).map(item => [item.url, item])).values()];
    return {
      text: pages.map(page => `Brave search snippets only; full pages not fetched. Query: ${page.query}\n` +
        page.items.map(item => `${item.title}\n${item.url}\n${item.description}\n${item.extra_snippets?.join('\n') ?? ''}`).join('\n\n')).join('\n\n').slice(0, 40000),
      sources: items.map(item => ({ url: item.url, title: item.title })),
    };
  }
  private async braveResearch(context: DiscoveryContext, alreadyFound: Product[], pass: number, plan: SourcePlan, signal?: AbortSignal, onActivity?: DiscoveryActivityProgress): Promise<Research> {
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
      const domain = query.match(/\bsite:([\w.-]+)/)?.[1];
      await onActivity?.(domain ? `Looking for product offers on ${domain} via web search.` : 'Searching product offers across the web.');
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
      images: thumbnailImages(items),
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
    const schema = z.object({ web: z.object({ results: z.array(z.object({
      title: z.string(), url: z.string(), description: z.string(), extra_snippets: z.array(z.string()).optional(),
      thumbnail: z.object({ src: z.string().nullish(), original: z.string().nullish(), logo: z.boolean().nullish() }).passthrough().nullish(),
    })) }).optional() });
    let results: z.infer<typeof schema>;
    try { results = schema.parse(await response.json()); }
    catch { throw new AppError(502, 'Brave returned invalid search data.', 'SEARCH_INVALID_DATA'); }
    const items = (results.web?.results ?? []).flatMap(r => { const safe = safeUrl(r.url); return safe ? [{ ...r, url: safe }] : []; });
    return { items };
  }
}
