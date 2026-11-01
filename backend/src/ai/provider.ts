import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DISCOVERY_MIN_PRODUCTS, OfferSchema, effectiveConfig, rankProducts, type ChatMessage, type DiscoveryContext, type Product, type ShoppingConfig, type Source, type AttrValue, type Field } from '@fairbuy/core';
import type { Settings } from '../settings';
import { AppError } from '../errors';
import { safeUrl } from '../links';
import { MetaClient, type Research } from './meta';
import { ConversationResultSchema, ExtractionSchema, LearnedResultSchema, type Extraction } from './schemas';
import { ASK_PROMPT, CONFIGURE_PROMPT, DISCOVERY_PROMPT, EXTRACT_PROMPT, LEARN_PROMPT } from './prompts';
import { streamObjectArray } from './json-stream';

export type ConversationResult = z.infer<typeof ConversationResultSchema>;
export type LearnedResult = z.infer<typeof LearnedResultSchema>;
export interface DiscoveryResult { products: Product[]; sources: Source[]; summary: string }
export type DiscoveryProgress = (result: DiscoveryResult) => Promise<void>;
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
    products.set(product.id, { ...product, offers: [...new Map([...(existing?.offers ?? []), ...product.offers].map(o => [o.id, o])).values()] });
  }
  return {
    products: [...products.values()], sources: [...new Map([...current.sources, ...incoming.sources].map(s => [s.url, s])).values()],
    summary: incoming.summary || current.summary,
  };
}
export function productId(name: string) {
  return createHash('sha256').update(name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')).digest('hex').slice(0, 20);
}
export function normalizeExtraction(extracted: Extraction, research: Research, context: DiscoveryContext): DiscoveryResult {
  const allowed = new Set(research.sources.map(s => s.url));
  const discarded = new Set(context.discardedProducts.map(p => p.id));
  const now = new Date().toISOString();
  let rejected = 0;
  const products = extracted.products.flatMap(raw => {
    const id = productId(raw.name);
    if (discarded.has(id)) return [];
    const offers = raw.offers.flatMap(rawOffer => {
      const url = safeUrl(rawOffer.url);
      if (!url || !allowed.has(url) || !rawOffer.quote.trim() || !research.text.includes(rawOffer.quote)) { rejected++; return []; }
      const evidence = [{ sourceType: 'url' as const, ref: url, snippet: rawOffer.quote, at: now }];
      const attributes: Record<string, Field<AttrValue>> = {};
      for (const attr of rawOffer.attributes) {
        if (!attr.quote.trim() || !research.text.includes(attr.quote)) continue;
        const value: AttrValue | null = attr.number !== null ? { kind: 'number', value: attr.number, unit: attr.unit ?? '' }
          : attr.boolean !== null ? { kind: 'bool', value: attr.boolean }
          : attr.text !== null ? { kind: 'text', value: attr.text } : null;
        if (value) attributes[attr.key] = { status: 'seller_claim', value, evidence: [{ ...evidence[0], snippet: attr.quote }] };
      }
      const components = ([['item', rawOffer.price], ['shipping', rawOffer.shipping], ['other', rawOffer.fees]] as const).map(([kind, amount]) => ({
        kind, amountCents: amount === null ? 0 : Math.round(amount * 100), status: amount === null ? 'unknown' as const : 'seller_claim' as const,
        label: kind === 'other' ? 'Taxes / fees' : kind,
      }));
      const missing = [...new Set([
        ...rawOffer.missing,
        ...(rawOffer.price === null ? ['Item price'] : []), ...(rawOffer.shipping === null ? ['Shipping'] : []),
        ...(rawOffer.fees === null ? ['Taxes / fees'] : []), ...(rawOffer.availability === 'unknown' ? ['Availability'] : []),
      ])];
      const offer = OfferSchema.parse({
        schemaVersion: 1, id: createHash('sha256').update(url).digest('hex').slice(0, 20),
        category: context.config.category ?? 'products', mode: 'live', provenanceUrl: url,
        fetchedAt: now, title: raw.name, seller: rawOffer.seller, availability: rawOffer.availability,
        condition: rawOffer.condition === 'unknown' ? { status: 'unknown' } : { status: 'seller_claim', value: rawOffer.condition, evidence },
        price: { currency: rawOffer.currency, components, totalIsLowerBound: components.some(c => c.status === 'unknown') },
        attributes, missing, evidence,
      });
      return [offer];
    });
    return offers.length ? [{ id, name: raw.name, summary: raw.summary, why: raw.why, tradeoffs: raw.tradeoffs, offers }] : [];
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
    summary: `${extracted.summary}${rejected ? ` ${rejected} offer(s) were rejected because their URL or evidence could not be grounded in this search.` : ''}`,
  };
}

export class LiveAIProvider implements AIProvider {
  private client: MetaClient;
  constructor(private config: Settings, private fetcher: typeof fetch = fetch) { this.client = new MetaClient(config, fetcher); }
  ensureConfigured() { this.client.ensureConfigured(); }
  async converse(phase: 'ask' | 'configure', messages: ChatMessage[], config: ShoppingConfig) {
    return this.client.structured(
      phase === 'ask' ? this.config.ASK_MODEL : this.config.CONFIGURE_MODEL,
      phase === 'ask' ? ASK_PROMPT : CONFIGURE_PROMPT, { phase, currentConfig: config, conversation: messages }, ConversationResultSchema,
    );
  }
  async learn(context: DiscoveryContext, reason: string, product: Product | null) {
    return this.client.structured(this.config.CONFIGURE_MODEL, LEARN_PROMPT, { context, feedback: reason, product }, LearnedResultSchema);
  }
  async discover(context: DiscoveryContext, onProgress?: DiscoveryProgress) {
    let result: DiscoveryResult = { products: [], sources: [], summary: '' };
    const eligibleCount = () => {
      const ranked = new Set(rankProducts(result.products, context).ranked.map(r => r.offerId));
      return result.products.filter(p => p.offers.some(o => ranked.has(o.id))).length;
    };
    // Bounded complementary searches, not retries of failed provider requests.
    for (let pass = 0; pass < 3 && eligibleCount() < DISCOVERY_MIN_PRODUCTS; pass++) {
      const input = {
        ...context, effectiveConfig: effectiveConfig(context), searchPass: pass + 1,
        minimumProducts: DISCOVERY_MIN_PRODUCTS, productsNeeded: DISCOVERY_MIN_PRODUCTS - eligibleCount(),
        alreadyFound: result.products, excludedOffers: rankProducts(result.products, context).excluded,
      };
      const research = this.config.SEARCH_PROVIDER === 'brave' ? await this.braveResearch(context, result.products, pass)
        : await this.client.research(this.config.DISCOVERY_MODEL, DISCOVERY_PROMPT, input);
      if (!research.sources.length) continue;
      const accept = async (incoming: DiscoveryResult) => {
        result = mergeDiscoveryResults(result, incoming);
        await onProgress?.(result);
      };
      const streamed = new Set<string>();
      const onText = streamObjectArray('products', async raw => {
        const parsed = ExtractionSchema.shape.products.element.safeParse(raw);
        if (!parsed.success) return;
        const grounded = normalizeExtraction({ summary: '', products: [parsed.data] }, research, context);
        if (grounded.products.length) {
          grounded.products.forEach(p => streamed.add(p.id));
          await accept(grounded);
        }
      });
      const extracted = await this.client.structured(this.config.DISCOVERY_MODEL, EXTRACT_PROMPT, { context: input, research }, ExtractionSchema, {
        // Extraction is mechanical: spend fewer tokens reasoning and more on the JSON result.
        max_output_tokens: 16000, reasoning: { effort: 'low' },
      }, onText);
      // Also handles providers that send only a terminal event, and commits the final summary.
      const grounded = normalizeExtraction(extracted, research, context);
      for (const product of grounded.products) if (!streamed.has(product.id)) await accept({ products: [product], sources: grounded.sources, summary: '' });
      await accept({ products: [], sources: grounded.sources, summary: grounded.summary });
    }
    const count = eligibleCount();
    if (count < DISCOVERY_MIN_PRODUCTS) result.summary = `${result.summary}${result.summary ? ' ' : ''}Only ${count} distinct eligible product${count === 1 ? '' : 's'} could be grounded after additional searches. We could not reach ${DISCOVERY_MIN_PRODUCTS} without relaxing your requirements or inventing offers.`;
    return result;
  }
  private async braveResearch(context: DiscoveryContext, alreadyFound: Product[], pass: number): Promise<Research> {
    this.ensureConfigured();
    const config = effectiveConfig(context);
    const q = [config.category, pass ? `alternative models ${alreadyFound.slice(0, 4).map(p => `-"${p.name}"`).join(' ')}` : '', ...context.feedback.slice().reverse().flatMap(f => f.learned.map(r => r.label)), ...config.requirements.map(r => r.label), config.purpose,
      config.budgetMax ? `under ${config.budgetMax} ${config.currency}` : '', config.country, config.city, 'buy price'].filter(Boolean).join(' ').slice(0, 400);
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', q); url.searchParams.set('count', '15'); url.searchParams.set('extra_snippets', 'true');
    let response: Response;
    try {
      response = await this.fetcher(url, { headers: { 'X-Subscription-Token': this.config.BRAVE_API_KEY, Accept: 'application/json' }, signal: AbortSignal.timeout(20000), redirect: 'error' });
    } catch { throw new AppError(502, 'Brave search could not be reached. Please retry.', 'SEARCH_UNREACHABLE'); }
    if (!response.ok) { await response.body?.cancel(); throw new AppError(502, 'Brave search rejected the request. Check your search API key, credit and limits.', 'SEARCH_PROVIDER_ERROR'); }
    const schema = z.object({ web: z.object({ results: z.array(z.object({ title: z.string(), url: z.string(), description: z.string(), extra_snippets: z.array(z.string()).optional() })) }).optional() });
    let results: z.infer<typeof schema>;
    try { results = schema.parse(await response.json()); }
    catch { throw new AppError(502, 'Brave returned invalid search data.', 'SEARCH_INVALID_DATA'); }
    const items = (results.web?.results ?? []).flatMap(r => { const safe = safeUrl(r.url); return safe ? [{ ...r, url: safe }] : []; });
    return {
      text: `Brave search snippets only; full pages not fetched. Query: ${q}\n` + items.map(r => `${r.title}\n${r.url}\n${r.description}\n${r.extra_snippets?.join('\n') ?? ''}`).join('\n\n').slice(0, 40000),
      sources: items.map(r => ({ url: r.url, title: r.title })),
    };
  }
}
