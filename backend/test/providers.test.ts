import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { EMPTY_CONFIG, rankProducts, sourcePlan, type DiscoveryContext, type SourceEntry } from '@fairbuy/core';
import { SOURCE_CATALOG_SEED } from '../../data/source-catalog';
import { acceptableProductCount, discoveryPolicy, DISCOVERY_TIMEOUT_MS, normalizeExtraction, LiveAIProvider } from '../src/ai/provider';
import { MetaClient } from '../src/ai/meta';
import { ExtractionSchema } from '../src/ai/schemas';
import { settings } from '../src/settings';
import { safeUrl } from '../src/links';

vi.mock('../src/product-images', () => ({ findSellerImage: vi.fn().mockResolvedValue(null) }));

const config = settings({ MODEL_API_KEY: 'test-not-a-real-key', SEARCH_PROVIDER: 'meta' });
afterEach(() => vi.restoreAllMocks());
const context: DiscoveryContext = { sessionId: 'shopping', discoverySessionId: 'unique-round', initialRequest: 'Laptop', initialConfig: EMPTY_CONFIG, config: EMPTY_CONFIG, previousProducts: [], discardedProducts: [], feedback: [] };
const research = { text: 'Aster Laptop costs EUR 590. 16 GB RAM. Official image available.', sources: [{ url: 'https://shop.fairbuy-fixture.org/aster', title: 'Aster' }] };
const extracted = ExtractionSchema.parse({ summary: 'Found one.', products: [{ name: 'Aster', summary: 'A laptop', why: '16 GB RAM', tradeoffs: [], imageUrl: 'https://cdn.shop.fairbuy-fixture.org/aster.png', offers: [{
  url: research.sources[0].url, seller: 'Test-only seller', price: 590, currency: 'EUR', availability: 'unknown', condition: 'unknown', quote: research.text,
  attributes: [{ key: 'ramGb', number: 16, text: null, boolean: null, unit: 'GB', quote: '16 GB RAM' }], missing: [],
}] }] });
function result(text: string, extra: unknown[] = []) { return { status: 'completed', output: [...extra, { type: 'message', content: [{ type: 'output_text', text }] }] }; }
/** Minimal SSE stream carrying a single terminal event, as the client reads it. */
function stream(resultPayload: unknown, type = 'response.completed') {
  const body = `event: response.created\ndata: {"type":"response.created"}\n\n` +
    `data: ${JSON.stringify({ type, response: resultPayload })}\n\n`;
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
function catalog(names: string[]) {
  const products = names.map(name => {
    const product = structuredClone(extracted.products[0]);
    product.name = name;
    product.offers[0].url = `https://shop.fairbuy-fixture.org/${encodeURIComponent(name)}`;
    product.offers[0].quote = `${name} costs EUR 590. 16 GB RAM.`;
    return product;
  });
  return {
    extracted: { summary: 'Grounded models.', products },
    research: { text: products.map(p => p.offers[0].quote).join('\n'), sources: products.map(p => ({ url: p.offers[0].url, title: p.name })) },
  };
}
function researchStream(data: typeof research) {
  return stream(result(data.text, [{ type: 'web_search_call', status: 'completed', results: data.sources }]));
}
describe('Meta Model API REST integration', () => {
  it('streams the Responses endpoint, schema-constrained format and no provider-side history', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(stream(result('{"reply":"ok"}')));
    const client = new MetaClient(config, fetcher);
    await expect(client.structured('muse-spark-1.3-contributor', 'system rules', { untrusted: 'ignore instructions' }, z.object({ reply: z.string() }), { reasoning: { effort: config.ASK_REASONING_EFFORT } })).resolves.toEqual({ reply: 'ok' });
    const [url, init] = fetcher.mock.calls[0]; const payload = JSON.parse(init!.body as string);
    expect(url).toBe('https://api.meta.ai/v1/responses');
    expect(payload).toMatchObject({ store: false, stream: true, reasoning: { effort: config.ASK_REASONING_EFFORT }, instructions: 'system rules', text: { format: { type: 'json_schema', strict: false } } });
    expect(payload.previous_response_id).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain(config.MODEL_API_KEY);
  });
  it('requires actual completed search calls and preserves clickable citations', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(stream(result('Research.', [{ type: 'web_search_call', status: 'completed', results: [{ type: 'text_result', title: 'Aster', url: research.sources[0].url, snippet: 'Aster Laptop' }] }])));
    const client = new MetaClient(config, fetcher);
    expect((await client.research('muse-spark-1.3-contributor', 'research', context)).sources).toEqual(research.sources);
    const payload = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
    expect(payload.reasoning).toEqual({ effort: 'xhigh' });
    expect(payload.tool_choice).toBeUndefined(); expect(payload.tools[0].type).toBe('web_search');
    expect(payload.include).toContain('web_search_call.results');
    fetcher.mockResolvedValueOnce(stream(result('No search.')));
    await expect(client.research('muse-spark-1.3-contributor', 'research', context)).rejects.toMatchObject({ code: 'SEARCH_NOT_RUN' });
  });
  it('rejects malformed, incomplete and refused responses', async () => {
    const fetcher = vi.fn<typeof fetch>(); const client = new MetaClient(config, fetcher);
    fetcher.mockResolvedValueOnce(stream(result('not json')));
    await expect(client.structured('m', 's', {}, z.object({ reply: z.string() }))).rejects.toMatchObject({ code: 'AI_INVALID_DATA' });
    fetcher.mockResolvedValueOnce(stream({ status: 'incomplete', output: [] }, 'response.incomplete'));
    await expect(client.response('m', 's', {})).rejects.toMatchObject({ code: 'AI_INCOMPLETE' });
    // An empty stream with no terminal event never completes.
    fetcher.mockResolvedValueOnce(new Response('', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    await expect(client.response('m', 's', {})).rejects.toMatchObject({ code: 'AI_INCOMPLETE' });
    fetcher.mockResolvedValueOnce(stream({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal' }] }] }));
    await expect(client.response('m', 's', {})).rejects.toMatchObject({ code: 'AI_EMPTY_RESPONSE' });
  });
  it('aborts an in-flight discovery request when its hard-limit signal fires', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });
    const client = new MetaClient(config, fetcher);
    const controller = new AbortController();
    const pending = client.research('m', 's', context, controller.signal);
    await new Promise(resolve => setTimeout(resolve, 0));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'AI_ABORTED' });
  });
  it('redacts provider failures and supports the optional Brave connector', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('SECRET upstream body', { status: 401 }));
    await expect(new MetaClient(config, fetcher).response('m', 's', {})).rejects.toMatchObject({ code: 'AI_ACCESS_DENIED' });
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'model_not_found', type: 'invalid_request_error' } }), { status: 404, headers: { 'Content-Type': 'application/json' } }));
    await expect(new MetaClient(config, fetcher).response('muse-spark-1.3-contributor', 's', {})).rejects.toMatchObject({ code: 'AI_MODEL_UNAVAILABLE' });
    fetcher.mockImplementation(async url => String(url).startsWith('https://api.search.brave.com/')
      ? new Response(JSON.stringify({ web: { results: [{ title: 'Aster', url: research.sources[0].url, description: research.text }] } }), { status: 200 })
      : stream(result(JSON.stringify(extracted))));
    const provider = new LiveAIProvider({ ...config, SEARCH_PROVIDER: 'brave', BRAVE_API_KEY: 'test-not-a-real-key', BRAVE_MIN_INTERVAL_MS: 0 }, fetcher);
    const discovered = await provider.discover(context);
    expect(discovered.products).toHaveLength(1);
    expect(discovered.summary).toContain('Only 1 distinct eligible product');
    expect(fetcher).toHaveBeenCalledTimes(8); // two failures above, then three search/extraction passes
    expect(String(fetcher.mock.calls[2][0])).toContain('https://api.search.brave.com/res/v1/web/search');
    expect(new URL(String(fetcher.mock.calls[4][0])).searchParams.get('q')).toContain('alternative models');
    expect(JSON.parse(fetcher.mock.calls[3][1]!.body as string).tools).toBeUndefined();
  });
});
describe('progressive multi-product discovery', () => {
  it('enriches visible products with seller page images without blocking streamed results', async () => {
    const data = catalog(['Aster', 'Birch', 'Cedar', 'Dune']);
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(researchStream(data.research))
      .mockResolvedValueOnce(stream(result(JSON.stringify(data.extracted))));
    let release!: (url: string) => void;
    const image = new Promise<string>(resolve => { release = resolve; });
    const imageFinder = vi.fn().mockReturnValue(image);
    const updates: (string | null)[][] = [];
    const pending = new LiveAIProvider(config, fetcher, imageFinder).discover(context, async update => {
      updates.push(update.products.map(p => p.imageUrl));
      if (update.products.length === 4) release('https://seller-cdn.org/laptop.jpg');
    });
    const discovered = await pending;
    expect(updates[0]).toEqual([extracted.products[0].imageUrl]);
    expect(updates.at(-1)).toEqual(Array(4).fill('https://seller-cdn.org/laptop.jpg'));
    expect(discovered.products.every(p => p.imageUrl === 'https://seller-cdn.org/laptop.jpg')).toBe(true);
    expect(imageFinder).toHaveBeenCalledTimes(4);
  });
  it('lowers the stopping threshold with actual elapsed time, not pass count or reasoning effort', () => {
    expect(discoveryPolicy(0, 0)).toMatchObject({ matchStrategy: 'quick_start', researchTarget: 1, minimumSoftMatch: 0.75 });
    expect(discoveryPolicy(1, 1000).matchStrategy).toBe('focused');
    expect(discoveryPolicy(0, 45000)).toMatchObject({ matchStrategy: 'broader', minimumSoftMatch: 0.375 });
    expect(discoveryPolicy(1, 90000)).toMatchObject({ matchStrategy: 'best_available', minimumSoftMatch: 0 });
    expect(discoveryPolicy(2, 0).minimumSoftMatch).toBe(0.75);
    expect(discoveryPolicy(0, 180000).minimumSoftMatch).toBe(0);
    expect(discoveryPolicy(0, -1000).minimumSoftMatch).toBe(0.75);
    expect(discoveryPolicy(0, 90000)).not.toHaveProperty('reasoningEffort');
  });
  it('accepts imperfect soft matches over time without admitting hard failures or changing ranking', () => {
    const data = catalog(['Aster', 'Birch', 'Cedar', 'Dune']);
    const brief = structuredClone(context);
    brief.config.requirements = [8, 32].map(value => ({ label: `${value} GB RAM`, hard: false, attribute: 'ramGb', op: '>=' as const, value, unit: 'GB' }));
    const result = normalizeExtraction(data.extracted, data.research, brief);
    const ranking = rankProducts(result.products, brief);
    expect(acceptableProductCount(result, brief, 0)).toBe(0);
    expect(acceptableProductCount(result, brief, 45000)).toBe(4);
    expect(rankProducts(result.products, brief)).toEqual(ranking);
    brief.config.requirements[1].hard = true;
    expect(acceptableProductCount(result, brief, 180000)).toBe(0);
  });
  it('publishes imperfect options immediately but stops further research only when time makes them acceptable', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const data = catalog(['Aster', 'Birch', 'Cedar', 'Dune']);
    const brief = structuredClone(context);
    brief.config.requirements = [8, 32].map(value => ({ label: `${value} GB RAM`, hard: false, attribute: 'ramGb', op: '>=' as const, value, unit: 'GB' }));
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(researchStream(data.research)).mockResolvedValueOnce(stream(result(JSON.stringify(data.extracted))))
      .mockResolvedValueOnce(researchStream(data.research)).mockImplementationOnce(async () => {
        now = 90000; return stream(result(JSON.stringify(data.extracted)));
      });
    const updates: number[] = [];
    const discovered = await new LiveAIProvider(config, fetcher).discover(brief, async update => { if (!now) updates.push(update.products.length); });
    expect(updates).toContain(1); expect(updates).toContain(4);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(discovered.products).toHaveLength(4);
    for (const index of [0, 2]) expect(JSON.parse(fetcher.mock.calls[index][1]!.body as string).reasoning.effort).toBe(config.DISCOVERY_REASONING_EFFORT);
  });
  it('publishes the first grounded product while extraction is still streaming, then stops at four', async () => {
    const data = catalog(['Aster', 'Birch', 'Cedar', 'Dune']);
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const send = (message: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(message)}\r\n\r\n`));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(researchStream(data.research))
      .mockResolvedValueOnce(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }));
    let firstReady!: () => void;
    const first = new Promise<void>(resolve => { firstReady = resolve; });
    const counts: number[] = []; let complete = false;
    const pending = new LiveAIProvider(config, fetcher).discover(context, async update => {
      counts.push(update.products.length);
      if (update.products.length === 1) firstReady();
    }).finally(() => { complete = true; });
    send({ type: 'response.output_text.delta', delta: `{"summary":"Grounded models.","products":[${JSON.stringify(data.extracted.products[0])}` });
    await first;
    expect(counts).toEqual([1]); expect(complete).toBe(false);
    const rest = `,${data.extracted.products.slice(1).map(p => JSON.stringify(p)).join(',')}]}`;
    for (let i = 0; i < rest.length; i += 23) send({ type: 'response.output_text.delta', delta: rest.slice(i, i + 23) });
    send({ type: 'response.completed', response: result(JSON.stringify(data.extracted)) });
    controller.close();
    expect((await pending).products).toHaveLength(4);
    expect(counts).toEqual([1, 2, 3, 4, 4]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('searches for complementary models until four qualify, without counting duplicates or exclusions', async () => {
    const passes = [catalog(['Aster', 'Unavailable']), catalog(['Aster', 'Birch', 'Cedar']), catalog(['Dune'])];
    passes[0].extracted.products[1].offers[0].availability = 'sold_out';
    const fetcher = vi.fn<typeof fetch>();
    for (const pass of passes) fetcher.mockResolvedValueOnce(researchStream(pass.research)).mockResolvedValueOnce(stream(result(JSON.stringify(pass.extracted))));
    const discovered = await new LiveAIProvider(config, fetcher).discover(context);
    expect(discovered.products).toHaveLength(5);
    expect(discovered.products.find(p => p.name === 'Aster')?.offers).toHaveLength(1);
    expect(rankProducts(discovered.products, context).ranked).toHaveLength(4);
    const inputs = [0, 2, 4].map(index => JSON.parse(JSON.parse(fetcher.mock.calls[index][1]!.body as string).input));
    expect(inputs.map(input => input.productsNeeded)).toEqual([4, 3, 1]);
    expect(inputs.map(input => input.searchPolicy.matchStrategy)).toEqual(['quick_start', 'focused', 'focused']);
    expect(inputs[0].searchPolicy.researchTarget).toBe(1);
    expect(inputs[1].excludedOffers).toHaveLength(1);
    expect(inputs[2].alreadyFound.map((p: { name: string }) => p.name)).toEqual(['Aster', 'Unavailable', 'Birch', 'Cedar']);
    expect(discovered.summary).not.toContain('could not reach');
  });
  it('does not publish streamed products with ungrounded evidence', async () => {
    const data = catalog(['Aster', 'Birch', 'Cedar', 'Dune']);
    const invented = structuredClone(data.extracted.products[0]); invented.name = 'Invented'; invented.offers[0].quote = 'Not in research';
    const json = JSON.stringify({ ...data.extracted, products: [invented, ...data.extracted.products] });
    const body = `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: json })}\n\n` +
      `data: ${JSON.stringify({ type: 'response.completed', response: result(json) })}\n\n`;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(researchStream(data.research)).mockResolvedValueOnce(new Response(body));
    const updates: string[][] = [];
    const discovered = await new LiveAIProvider(config, fetcher).discover(context, async update => { updates.push(update.products.map(p => p.name)); });
    expect(discovered.products).toHaveLength(4);
    expect(updates[0]).toEqual(['Aster']);
    expect(updates.flat()).not.toContain('Invented');
    expect(discovered.summary).toContain('1 offer(s) were rejected');
  });
  it('passes category-aware source hints to research without treating them as evidence', async () => {
    const brief = structuredClone(context);
    brief.config = { ...EMPTY_CONFIG, category: 'laptop', country: 'IT', purpose: 'software development' };
    const data = catalog(['Aster', 'Birch', 'Cedar', 'Dune']);
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(researchStream(data.research))
      .mockResolvedValueOnce(stream(result(JSON.stringify(data.extracted))));
    await new LiveAIProvider(config, fetcher).discover(brief);
    const input = JSON.parse(JSON.parse(fetcher.mock.calls[0][1]!.body as string).input);
    expect(input.sourcePlan.vertical).toBe('computers');
    expect(input.sourcePlan.sellers.map((source: { domain: string }) => source.domain)).toContain('mediaworld.it');
    expect(input.sourcePlan.specs.map((source: { domain: string }) => source.domain)).toContain('openicecat.com');
    expect(fetcher.mock.calls[0][1]!.body as string).toContain('openicecat.com');
  });
  it('uses the persisted catalog loader when one is supplied', async () => {
    const brief = structuredClone(context);
    brief.config = { ...EMPTY_CONFIG, category: 'laptop', country: 'CH', purpose: 'software development' };
    const data = catalog(['Aster', 'Birch', 'Cedar', 'Dune']);
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(researchStream(data.research))
      .mockResolvedValueOnce(stream(result(JSON.stringify(data.extracted))));
    const custom: SourceEntry = { domain: 'custom-shop.ch', name: 'Custom Shop', roles: ['seller'], verticals: ['computers'], countries: ['CH'], priority: 3 };
    await new LiveAIProvider(config, fetcher, undefined, { effective: async () => [custom] }).discover(brief);
    const input = JSON.parse(JSON.parse(fetcher.mock.calls[0][1]!.body as string).input);
    expect(input.sourcePlan.sellers.map((source: { domain: string }) => source.domain)).toEqual(['custom-shop.ch']);
  });
  it('rejects an offer grounded only on a specification or comparison page', () => {
    const brief = structuredClone(context);
    brief.config = { ...EMPTY_CONFIG, category: 'laptop', country: 'IT' };
    const specResearch = { text: 'The Aster Laptop costs EUR 590 and has 16 GB RAM.', sources: [{ url: 'https://www.openicecat.com/en/product/aster', title: 'Open Icecat' }] };
    const specExtracted = ExtractionSchema.parse({
      summary: 'Found one.', products: [{ ...extracted.products[0], offers: [{ ...extracted.products[0].offers[0], url: specResearch.sources[0].url, quote: specResearch.text }] }],
    });
    const grounded = normalizeExtraction(specExtracted, specResearch, brief, sourcePlan(brief.config, SOURCE_CATALOG_SEED));
    expect(grounded.products).toEqual([]);
    expect(grounded.summary).toContain('specification, review or comparison page is not a seller');
  });
  it('bounds empty research without making up products or looping forever', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => researchStream({ text: 'No matches.', sources: [] }));
    const discovered = await new LiveAIProvider(config, fetcher).discover(context);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(discovered.products).toEqual([]);
    expect(discovered.summary).toContain('Only 0 distinct eligible products');
  });
  it('stops starting new search passes at the five-minute hard limit and keeps partial results', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const data = catalog(['Aster']);
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(researchStream(data.research))
      .mockImplementationOnce(async () => { now = DISCOVERY_TIMEOUT_MS; return stream(result(JSON.stringify(data.extracted))); });
    const discovered = await new LiveAIProvider(config, fetcher).discover(context);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(discovered.products).toHaveLength(1);
    expect(discovered.summary).toContain('5-minute limit');
  });
  it.each([false, true])('broadens Brave preferences while preserving hard budget=%s and must-haves', async budgetHard => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const brief = structuredClone(context);
    brief.config = { ...EMPTY_CONFIG, category: 'laptop', country: 'IT', budgetMax: 700, budgetHard, requirements: [
      { label: 'Matte screen', hard: false, attribute: 'screen', op: '=', value: 'matte', unit: null },
      { label: 'Required compatibility', hard: true, attribute: 'compatible', op: '=', value: true, unit: null },
    ] };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => {
      if (String(url).startsWith('https://api.search.brave.com/')) return new Response(JSON.stringify({ web: { results: [{ title: 'Aster', url: research.sources[0].url, description: research.text }] } }));
      now = 45000;
      return stream(result(JSON.stringify(extracted)));
    });
    await new LiveAIProvider({ ...config, SEARCH_PROVIDER: 'brave', BRAVE_API_KEY: 'test-key', BRAVE_MIN_INTERVAL_MS: 0 }, fetcher).discover(brief);
    const queries = fetcher.mock.calls.filter(([url]) => String(url).startsWith('https://api.search.brave.com/')).map(([url]) => new URL(String(url)).searchParams.get('q')!);
    const broad = queries.filter(query => !query.includes('site:'));
    const targeted = queries.filter(query => query.includes('site:'));
    expect(broad).toHaveLength(3);
    // Eight planned sellers are covered in rotating groups of at most three.
    expect(targeted).toHaveLength(8);
    expect(new Set(targeted).size).toBe(8);
    expect(broad[0]).toContain('Matte screen');
    for (const query of broad.slice(1)) {
      expect(query).not.toContain('Matte screen');
      expect(query).toContain('Required compatibility'); expect(query).toContain('IT');
      expect(query.includes('under 700')).toBe(budgetHard);
    }
    for (const query of targeted) {
      expect(query).toContain('IT'); expect(query).toContain('site:');
      expect(query).not.toContain('Matte screen');
    }
    expect(brief.config.requirements[0].hard).toBe(false);
  });
  it('rotates Brave seller queries so a long watch plan reaches iwc.com', async () => {
    const brief = structuredClone(context);
    brief.config = { ...EMPTY_CONFIG, category: 'watch', country: 'CH', purpose: 'Swiss made steel moonphase watch', requirements: [
      { label: 'Swiss made', hard: true, attribute: 'origin', op: '=', value: 'Switzerland', unit: null },
    ] };
    const domains = ['beyer.ch', 'bucherer.com', 'cartier.com', 'chrono24.com', 'galaxus.ch', 'gubelin.com', 'iwc.com', 'longines.com'];
    const watchCatalog: SourceEntry[] = domains.map(domain => ({ domain, name: domain, roles: ['seller'], verticals: ['watches'], countries: ['CH'], priority: 3 }));
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => String(url).startsWith('https://api.search.brave.com/')
      ? new Response(JSON.stringify({ web: { results: [{ title: 'Aster', url: research.sources[0].url, description: research.text }] } }))
      : stream(result(JSON.stringify(extracted))));
    await new LiveAIProvider({ ...config, SEARCH_PROVIDER: 'brave', BRAVE_API_KEY: 'test-key', BRAVE_MIN_INTERVAL_MS: 0 }, fetcher, undefined, { effective: async () => watchCatalog }).discover(brief);
    const queries = fetcher.mock.calls.filter(([url]) => String(url).startsWith('https://api.search.brave.com/')).map(([url]) => new URL(String(url)).searchParams.get('q')!);
    expect(queries.some(query => query.includes('site:iwc.com'))).toBe(true);
    expect(queries.filter(query => !query.includes('site:'))).toHaveLength(3);
  });
  it('retries a Brave rate limit once and keeps the query result', async () => {
    let braveCalls = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => {
      if (String(url).startsWith('https://api.search.brave.com/')) {
        braveCalls++;
        if (braveCalls === 1) return new Response('rate limited', { status: 429 });
        return new Response(JSON.stringify({ web: { results: [{ title: 'Aster', url: research.sources[0].url, description: research.text }] } }));
      }
      return stream(result(JSON.stringify(extracted)));
    });
    const discovered = await new LiveAIProvider({ ...config, SEARCH_PROVIDER: 'brave', BRAVE_API_KEY: 'test-key', BRAVE_MIN_INTERVAL_MS: 0 }, fetcher).discover(context);
    expect(braveCalls).toBeGreaterThanOrEqual(4);
    expect(discovered.products).toHaveLength(1);
  });
});
describe('per-stage reasoning effort', () => {
  it('uses independent Ask and Configure efforts even when their model IDs match', async () => {
    const stageConfig = settings({ MODEL_API_KEY: config.MODEL_API_KEY, SEARCH_PROVIDER: 'meta', ASK_REASONING_EFFORT: 'minimal', CONFIGURE_REASONING_EFFORT: 'high' });
    const answer = { reply: 'What do you need?', config: EMPTY_CONFIG, ready: false, missing: [] };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(stream(result(JSON.stringify(answer))))
      .mockResolvedValueOnce(stream(result(JSON.stringify(answer))));
    const provider = new LiveAIProvider(stageConfig, fetcher);
    await provider.converse('ask', [], EMPTY_CONFIG);
    await provider.converse('configure', [], EMPTY_CONFIG);
    const payloads = fetcher.mock.calls.map(([, init]) => JSON.parse(init!.body as string));
    expect(payloads.map(p => p.model)).toEqual([stageConfig.ASK_MODEL, stageConfig.ASK_MODEL]);
    expect(payloads.map(p => p.reasoning.effort)).toEqual(['minimal', 'high']);
  });

  it('uses Configure effort for Learn interpretation', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(stream(result(JSON.stringify({ requirements: [], summary: 'Prefer lighter products.' }))));
    const provider = new LiveAIProvider({ ...config, CONFIGURE_REASONING_EFFORT: 'medium' }, fetcher);
    await provider.learn(context, 'Too heavy', null);
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toMatchObject({
      model: config.CONFIGURE_MODEL, reasoning: { effort: 'medium' },
    });
  });

  it.each(['xhigh', 'medium', 'minimal'] as const)('preserves configured %s research effort with time-aware acceptance', async effort => {
    const data = catalog(['Aster', 'Birch', 'Cedar', 'Dune']);
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(researchStream(data.research))
      .mockResolvedValueOnce(stream(result(JSON.stringify(data.extracted))));
    const provider = new LiveAIProvider({ ...config, DISCOVERY_REASONING_EFFORT: effort }, fetcher);
    expect((await provider.discover(context)).products).toHaveLength(4);
    const payloads = fetcher.mock.calls.map(([, init]) => JSON.parse(init!.body as string));
    expect(payloads.map(p => p.model)).toEqual([config.DISCOVERY_MODEL, config.DISCOVERY_MODEL]);
    expect(payloads.map(p => p.reasoning.effort)).toEqual([effort, 'low']);
    expect(payloads[0].max_output_tokens).toBe(16000);
  });
});
describe('untrusted search evidence', () => {
  it('only accepts product URLs, official-site images and literal evidence returned by this search', () => {
    const normalized = normalizeExtraction(extracted, research, context);
    expect(normalized.products).toHaveLength(1);
    expect(normalized.products[0].imageUrl).toBe('https://cdn.shop.fairbuy-fixture.org/aster.png');
    const fabricated = structuredClone(extracted); fabricated.products[0].offers[0].url = 'https://another-shop.org/invented';
    expect(normalizeExtraction(fabricated, research, context).products).toHaveLength(0);
    fabricated.products[0].offers[0].url = research.sources[0].url; fabricated.products[0].offers[0].quote = 'An invented quote';
    expect(normalizeExtraction(fabricated, research, context).products).toHaveLength(0);
    const unrelatedImage = structuredClone(extracted); unrelatedImage.products[0].imageUrl = 'https://unrelated.example.net/aster.png';
    const imageResult = normalizeExtraction(unrelatedImage, research, context);
    expect(imageResult.products[0].imageUrl).toBeNull();
    expect(imageResult.summary).toContain('1 image(s) were rejected');
  });
  it('keeps an unknown final price and stock unknown and never marks extraction verified', () => {
    const missingPrice = structuredClone(extracted); missingPrice.products[0].offers[0].price = null;
    const offer = normalizeExtraction(missingPrice, research, context).products[0].offers[0];
    expect(offer.price).toEqual({ currency: 'EUR', amountCents: null });
    expect(offer.missing).toContain('Final listed price');
    expect(offer.attributes.ramGb.status).toBe('seller_claim');
    expect(offer.availability).toBe('unknown');
  });
  it('rejects unsafe links and never fetches arbitrary seller URLs', () => {
    for (const value of ['http://shop.org/p', 'https://127.0.0.1/x', 'https://2130706433/x', 'https://[::1]/x', 'https://user:pass@shop.org/p', 'javascript:alert(1)', 'https://localhost/x', 'https://localhost./x', 'https://router.home/x', 'https://service.internal/x', 'https://example.com/fake', 'https://shop.org:8443/x']) expect(safeUrl(value)).toBeNull();
    expect(safeUrl('https://real-shop.org/p#section')).toBe('https://real-shop.org/p');
  });
});
