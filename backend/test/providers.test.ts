import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { EMPTY_CONFIG, rankProducts, type DiscoveryContext } from '@fairbuy/core';
import { normalizeExtraction, LiveAIProvider } from '../src/ai/provider';
import { MetaClient } from '../src/ai/meta';
import { ExtractionSchema } from '../src/ai/schemas';
import { settings } from '../src/settings';
import { safeUrl } from '../src/links';

const config = settings({ MODEL_API_KEY: 'test-not-a-real-key' });
const context: DiscoveryContext = { sessionId: 'shopping', discoverySessionId: 'unique-round', initialRequest: 'Laptop', initialConfig: EMPTY_CONFIG, config: EMPTY_CONFIG, previousProducts: [], discardedProducts: [], feedback: [] };
const research = { text: 'Aster Laptop costs EUR 590. Free shipping. Fees included. 16 GB RAM.', sources: [{ url: 'https://shop.fairbuy-fixture.org/aster', title: 'Aster' }] };
const extracted = ExtractionSchema.parse({ summary: 'Found one.', products: [{ name: 'Aster', summary: 'A laptop', why: '16 GB RAM', tradeoffs: [], offers: [{
  url: research.sources[0].url, seller: 'Test-only seller', price: 590, shipping: 0, fees: null, currency: 'EUR', availability: 'unknown', condition: 'unknown', quote: research.text,
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
    await expect(client.structured('muse-spark-1.3-contributor', 'system rules', { untrusted: 'ignore instructions' }, z.object({ reply: z.string() }))).resolves.toEqual({ reply: 'ok' });
    const [url, init] = fetcher.mock.calls[0]; const payload = JSON.parse(init!.body as string);
    expect(url).toBe('https://api.meta.ai/v1/responses');
    expect(payload).toMatchObject({ store: false, stream: true, reasoning: { effort: config.REASONING_EFFORT }, instructions: 'system rules', text: { format: { type: 'json_schema', strict: false } } });
    expect(payload.previous_response_id).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain(config.MODEL_API_KEY);
  });
  it('requires actual completed search calls and preserves clickable citations', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(stream(result('Research.', [{ type: 'web_search_call', status: 'completed', results: [{ type: 'text_result', title: 'Aster', url: research.sources[0].url, snippet: 'Aster Laptop' }] }])));
    const client = new MetaClient(config, fetcher);
    expect((await client.research('muse-spark-1.3-contributor', 'research', context)).sources).toEqual(research.sources);
    const payload = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
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
  it('redacts provider failures and supports the optional Brave connector', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('SECRET upstream body', { status: 401 }));
    await expect(new MetaClient(config, fetcher).response('m', 's', {})).rejects.toMatchObject({ code: 'AI_ACCESS_DENIED' });
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'model_not_found', type: 'invalid_request_error' } }), { status: 404, headers: { 'Content-Type': 'application/json' } }));
    await expect(new MetaClient(config, fetcher).response('muse-spark-1.3-contributor', 's', {})).rejects.toMatchObject({ code: 'AI_MODEL_UNAVAILABLE' });
    fetcher.mockImplementation(async url => String(url).startsWith('https://api.search.brave.com/')
      ? new Response(JSON.stringify({ web: { results: [{ title: 'Aster', url: research.sources[0].url, description: research.text }] } }), { status: 200 })
      : stream(result(JSON.stringify(extracted))));
    const provider = new LiveAIProvider({ ...config, SEARCH_PROVIDER: 'brave', BRAVE_API_KEY: 'test-not-a-real-key' }, fetcher);
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
  it('bounds empty research without making up products or looping forever', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => researchStream({ text: 'No matches.', sources: [] }));
    const discovered = await new LiveAIProvider(config, fetcher).discover(context);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(discovered.products).toEqual([]);
    expect(discovered.summary).toContain('Only 0 distinct eligible products');
  });
});
describe('untrusted search evidence', () => {
  it('only accepts product URLs and literal evidence returned by this search', () => {
    expect(normalizeExtraction(extracted, research, context).products).toHaveLength(1);
    const fabricated = structuredClone(extracted); fabricated.products[0].offers[0].url = 'https://another-shop.org/invented';
    expect(normalizeExtraction(fabricated, research, context).products).toHaveLength(0);
    fabricated.products[0].offers[0].url = research.sources[0].url; fabricated.products[0].offers[0].quote = 'An invented quote';
    expect(normalizeExtraction(fabricated, research, context).products).toHaveLength(0);
  });
  it('keeps unknown prices/fees/stock unknown and never marks extraction verified', () => {
    const offer = normalizeExtraction(extracted, research, context).products[0].offers[0];
    expect(offer.price.totalIsLowerBound).toBe(true);
    expect(offer.price.components[2].status).toBe('unknown');
    expect(offer.attributes.ramGb.status).toBe('seller_claim');
    expect(offer.availability).toBe('unknown');
  });
  it('rejects unsafe links and never fetches arbitrary seller URLs', () => {
    for (const value of ['http://shop.org/p', 'https://127.0.0.1/x', 'https://2130706433/x', 'https://[::1]/x', 'https://user:pass@shop.org/p', 'javascript:alert(1)', 'https://localhost/x', 'https://localhost./x', 'https://router.home/x', 'https://service.internal/x', 'https://example.com/fake', 'https://shop.org:8443/x']) expect(safeUrl(value)).toBeNull();
    expect(safeUrl('https://real-shop.org/p#section')).toBe('https://real-shop.org/p');
  });
});
