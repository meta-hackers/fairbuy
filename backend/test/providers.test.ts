import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { EMPTY_CONFIG, type DiscoveryContext } from '@fairbuy/core';
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
describe('Meta Model API REST integration', () => {
  it('uses the Responses endpoint, a schema-constrained format and no provider-side history', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(result('{"reply":"ok"}')), { status: 200 }));
    const client = new MetaClient(config, fetcher);
    await expect(client.structured('muse-spark-1.3-contributor', 'system rules', { untrusted: 'ignore instructions' }, z.object({ reply: z.string() }))).resolves.toEqual({ reply: 'ok' });
    const [url, init] = fetcher.mock.calls[0]; const payload = JSON.parse(init!.body as string);
    expect(url).toBe('https://api.meta.ai/v1/responses');
    expect(payload).toMatchObject({ store: false, reasoning: { effort: config.REASONING_EFFORT }, instructions: 'system rules', text: { format: { type: 'json_schema', strict: false } } });
    expect(payload.previous_response_id).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain(config.MODEL_API_KEY);
  });
  it('requires actual completed search calls and preserves clickable citations', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify(result('Research.', [{ type: 'web_search_call', status: 'completed', results: [{ type: 'text_result', title: 'Aster', url: research.sources[0].url, snippet: 'Aster Laptop' }] }])), { status: 200 }));
    const client = new MetaClient(config, fetcher);
    expect((await client.research('muse-spark-1.3-contributor', 'research', context)).sources).toEqual(research.sources);
    const payload = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
    expect(payload.tool_choice).toBeUndefined(); expect(payload.tools[0].type).toBe('web_search');
    expect(payload.include).toContain('web_search_call.results');
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(result('No search.')), { status: 200 }));
    await expect(client.research('muse-spark-1.3-contributor', 'research', context)).rejects.toMatchObject({ code: 'SEARCH_NOT_RUN' });
  });
  it('rejects malformed, incomplete and refused responses', async () => {
    const fetcher = vi.fn<typeof fetch>(); const client = new MetaClient(config, fetcher);
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(result('not json')), { status: 200 }));
    await expect(client.structured('m', 's', {}, z.object({ reply: z.string() }))).rejects.toMatchObject({ code: 'AI_INVALID_DATA' });
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'incomplete', output: [] }), { status: 200 }));
    await expect(client.response('m', 's', {})).rejects.toMatchObject({ code: 'AI_INCOMPLETE' });
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal' }] }] }), { status: 200 }));
    await expect(client.response('m', 's', {})).rejects.toMatchObject({ code: 'AI_EMPTY_RESPONSE' });
  });
  it('redacts provider failures and supports the optional Brave connector', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('SECRET upstream body', { status: 401 }));
    await expect(new MetaClient(config, fetcher).response('m', 's', {})).rejects.toMatchObject({ code: 'AI_ACCESS_DENIED' });
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ web: { results: [{ title: 'Aster', url: research.sources[0].url, description: research.text }] } }), { status: 200 }));
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(result(JSON.stringify(extracted))), { status: 200 }));
    const provider = new LiveAIProvider({ ...config, SEARCH_PROVIDER: 'brave', BRAVE_API_KEY: 'test-not-a-real-key' }, fetcher);
    expect((await provider.discover(context)).products).toHaveLength(1);
    expect(String(fetcher.mock.calls[1][0])).toContain('https://api.search.brave.com/res/v1/web/search');
    expect(JSON.parse(fetcher.mock.calls[2][1]!.body as string).tools).toBeUndefined();
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
