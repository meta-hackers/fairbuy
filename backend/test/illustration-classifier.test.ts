import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_CONFIG, type Product } from '@fairbuy/core';
import { IllustrationClassifier } from '../src/illustration-classifier';
import { settings } from '../src/settings';
import { UsageStore } from '../src/usage';
import { DemoAIProvider } from '../src/ai/demo';
import { ShoppingService } from '../src/shopping-service';
import { MemoryStore } from '../src/store';

const config = (extra = {}) => settings({ NODE_ENV: 'test', FAIRBUY_MODE: 'live', ILLUSTRATION_CLASSIFIER_PROVIDER: 'cloudflare', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'test-only-secret', ...extra });
const product = (name = 'Speedmaster', category = 'Relojes'): Product => ({ id: 'p1', name, summary: '', why: '', tradeoffs: [], imageUrl: null, offers: [{ category }] as Product['offers'] });
const response = (value: unknown = { illustration: 'watch' }) => new Response(JSON.stringify({ success: true, result: { response: value, usage: { prompt_tokens: 100, completion_tokens: 8 } } }));
afterEach(() => vi.restoreAllMocks());

describe('optional Cloudflare illustration selection', () => {
  it('uses the configured model, bounded JSON and only the product name/category', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response());
    const classifier = new IllustrationClassifier(config(), fetcher);
    const original = product();
    const [result] = await classifier.enrich('session-a', [original], 'ignored');
    expect(result.illustration).toEqual({ slug: 'watch', model: config().ILLUSTRATION_CLASSIFIER_MODEL });
    expect(original).not.toHaveProperty('illustration');
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/ai/run/@cf/ibm-granite/granite-4.0-h-micro`);
    const body = JSON.parse(init!.body as string);
    expect(body).toMatchObject({ temperature: 0, max_tokens: 64, response_format: { type: 'json_object' } });
    expect(JSON.parse(body.messages[1].content)).toEqual({ category: 'Relojes', name: 'Speedmaster' });
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('reasoning');
    expect(init!.redirect).toBe('error');
    expect(init!.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(body)).not.toContain('session-a');
    expect(JSON.stringify(body)).not.toContain('test-only-secret');
  });

  it('accepts alternate models and JSON-string responses without changing code', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(JSON.stringify({ illustration: 'watch' })));
    const model = '@cf/other/small-instruct';
    const previous = { ...product(), illustration: { slug: 'generic', model: config().ILLUSTRATION_CLASSIFIER_MODEL } };
    const [result] = await new IllustrationClassifier(config({ ILLUSTRATION_CLASSIFIER_MODEL: model }), fetcher).enrich('s', [previous], '');
    expect(result.illustration?.model).toBe(model);
    expect(fetcher.mock.calls[0][0]).toContain(`/ai/run/${model}`);
  });

  it('never calls providers for deterministic aliases, disabled settings, absent credentials or demo mode', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const classifier = new IllustrationClassifier(config(), fetcher);
    expect((await classifier.enrich('s', [product('Tissot PRX', 'wrist watches')], ''))[0]).not.toHaveProperty('illustration');
    for (const extra of [{ ILLUSTRATION_CLASSIFIER_PROVIDER: 'disabled' }, { CLOUDFLARE_API_TOKEN: '' }, { CLOUDFLARE_ACCOUNT_ID: '' }, { FAIRBUY_MODE: 'demo' }]) {
      await new IllustrationClassifier(config(extra), fetcher).enrich('s', [product()], '');
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('uses the saved search category when an offer category is missing and limits input size', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response());
    await new IllustrationClassifier(config(), fetcher).enrich('s', [product('x'.repeat(500), '')], 'y'.repeat(200));
    const input = JSON.parse(JSON.parse(fetcher.mock.calls[0][1]!.body as string).messages[1].content);
    expect(input.name).toHaveLength(300); expect(input.category).toHaveLength(100);
  });

  it('caches within a session, coalesces duplicate calls and reuses persisted choices', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response());
    const classifier = new IllustrationClassifier(config(), fetcher);
    const [a, b] = await Promise.all([classifier.enrich('s1', [product()], ''), classifier.enrich('s1', [product()], '')]);
    expect(a).toEqual(b); expect(fetcher).toHaveBeenCalledTimes(1);
    await classifier.enrich('s1', [product()], '');
    await classifier.enrich('s1', a, '');
    expect(fetcher).toHaveBeenCalledTimes(1);
    await classifier.enrich('s2', [product()], '');
    expect(fetcher).toHaveBeenCalledTimes(2);
    const restartFetcher = vi.fn<typeof fetch>();
    await new IllustrationClassifier(config(), restartFetcher).enrich('s1', a, '');
    expect(restartFetcher).not.toHaveBeenCalled();
  });

  it.each([
    'not json', { illustration: '../private' }, { illustration: 'https://evil.test/img' }, { illustration: 'invented' },
    { illustration: 'watch', reasoning: 'extra output' }, ['watch'], null,
  ])('rejects invalid or untrusted output %j and caches failure briefly', async value => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(value));
    const classifier = new IllustrationClassifier(config(), fetcher);
    expect((await classifier.enrich('s', [product()], ''))[0]).not.toHaveProperty('illustration');
    await classifier.enrich('s', [product()], '');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([429, 500])('keeps generic fallback on HTTP %i without retries', async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('sensitive upstream error', { status }));
    expect(await new IllustrationClassifier(config(), fetcher).enrich('s', [product()], '')).toEqual([product()]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('records valid and invalid selections as usage without persisting provider bodies', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response()).mockRejectedValueOnce(new Error('secret upstream text'));
    const classifier = new IllustrationClassifier(config(), fetcher);
    const usage = new UsageStore();
    await usage.capture('s', 'discovery', 'r', async () => {
      await classifier.enrich('s', [product()], '');
      await classifier.enrich('s', [product('Different')], '');
    });
    expect((await usage.get('s')).map(event => [event.operation, event.status])).toEqual([
      ['illustration_classification', 'completed'], ['illustration_classification', 'failed'],
    ]);
    expect(JSON.stringify(await usage.get('s'))).not.toContain('secret');
  });

  it('caps the process-wide request count and resets its allowance after one day', async () => {
    let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response());
    const classifier = new IllustrationClassifier(config(), fetcher);
    for (let i = 0; i < 1001; i++) await classifier.enrich(`s${i}`, [product()], '');
    expect(fetcher).toHaveBeenCalledTimes(1000);
    now += 86400001;
    await classifier.enrich('new-day', [product()], '');
    expect(fetcher).toHaveBeenCalledTimes(1001);
  });

  it('bounds concurrency and keeps discovery usable when busy', async () => {
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    let active = 0, peak = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => { active++; peak = Math.max(peak, active); await gate; active--; return response(); });
    const classifier = new IllustrationClassifier(config(), fetcher);
    const pending = [0, 1, 2].map(i => classifier.enrich(`s${i}`, [product(), product('Other')], ''));
    expect(fetcher).toHaveBeenCalledTimes(4);
    finish(); await Promise.all(pending);
    expect(peak).toBe(4);
  });

  it('times out optional classification rather than failing or hanging discovery', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    expect(await new IllustrationClassifier(config(), fetcher).enrich('s', [product()], '')).toEqual([product()]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('persists model choices through progressive discovery, reload and Buy with no additional calls', async () => {
    const store = new MemoryStore();
    const ai = new DemoAIProvider();
    const original = ai.discover.bind(ai);
    ai.discover = async (context, onProgress) => {
      const result = await original(context);
      result.products = result.products.slice(0, 1).map(p => ({ ...p, name: 'Speedmaster', offers: p.offers.map(o => ({ ...o, category: 'Relojes' })) }));
      await onProgress?.(result);
      return result;
    };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response());
    const classifier = new IllustrationClassifier(config(), fetcher);
    const service = new ShoppingService(store, ai, 'live', undefined, config(), undefined, classifier);
    const created = await service.create('owner');
    await store.append(created.id, 'owner', s => { s.ready = true; s.config = { ...EMPTY_CONFIG, category: 'Relojes', purpose: 'daily use', country: 'IT' }; });
    await service.discover(created.id, 'owner');
    await service.runJob((await store.claim())!);
    const saved = await store.get(created.id, 'owner');
    expect(saved.rounds[0].status).toBe('complete');
    const chosen = saved.rounds[0].products[0];
    expect(chosen.illustration).toEqual({ slug: 'watch', model: config().ILLUSTRATION_CLASSIFIER_MODEL });
    await service.select(saved.id, 'owner', chosen.id);
    expect((await store.get(saved.id, 'owner')).rounds[0].products[0].illustration).toEqual(chosen.illustration);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
