import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstantClassifier } from '../src/instant-classifier';
import { settings } from '../src/settings';
import { createApp } from '../src/app';
import { ShoppingService } from '../src/shopping-service';
import { MemoryStore } from '../src/store';
import { DemoAIProvider } from '../src/ai/demo';

const hint = { category: { value: 'Laptop', evidence: 'laptop' }, budget: null, condition: null, requirements: [], clarification: null };
const config = () => settings({ NODE_ENV: 'test', FAIRBUY_MODE: 'live', INSTANT_CLASSIFIER_PROVIDER: 'cloudflare', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'test-only-cloudflare-token' });
const response = (value: unknown = hint) => new Response(JSON.stringify({ success: true, result: { response: value } }), { headers: { 'Content-Type': 'application/json' } });
afterEach(() => vi.restoreAllMocks());

describe('Cloudflare instant classifier', () => {
  it('calls only the fixed Cloudflare endpoint with a small non-reasoning Meta model and a bounded JSON response', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response());
    expect(await new InstantClassifier(config(), fetcher).classify('owner', 'A laptop')).toEqual(hint);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/ai/run/@cf/meta/llama-3.2-1b-instruct`);
    const body = JSON.parse(init!.body as string);
    expect(body).toMatchObject({ temperature: 0, max_tokens: 600, response_format: { type: 'json_schema' } });
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: 'A laptop' });
    expect(body).not.toHaveProperty('reasoning');
    expect(body).not.toHaveProperty('tools');
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
  it('accepts a JSON string response and removes unsupported evidence', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(JSON.stringify(hint)));
    const result = await new InstantClassifier(config(), fetcher).classify('owner', 'garden');
    expect(result.category).toBeNull();
  });
  it('caches briefly per owner, bounds the cache and never shares drafts across owners', async () => {
    let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response());
    const classifier = new InstantClassifier(config(), fetcher);
    const first = await classifier.classify('alice', 'laptop');
    first.category!.value = 'Modified by caller';
    expect((await classifier.classify('alice', 'laptop')).category?.value).toBe('Laptop');
    expect(fetcher).toHaveBeenCalledTimes(1);
    await classifier.classify('bob', 'laptop');
    expect(fetcher).toHaveBeenCalledTimes(2);
    now += 5 * 60000 + 1;
    await classifier.classify('alice', 'laptop');
    expect(fetcher).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 101; i++) await classifier.classify('alice', `laptop ${i}`);
    await classifier.classify('alice', 'laptop 0');
    expect(fetcher).toHaveBeenCalledTimes(105);
  });
  it('rejects overlapping requests by owner and caps global concurrency', async () => {
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => { await gate; return response(); });
    const classifier = new InstantClassifier(config(), fetcher);
    const active = ['alice', 'bob', 'carol', 'dave'].map(owner => classifier.classify(owner, 'laptop'));
    await expect(classifier.classify('alice', 'another laptop')).rejects.toMatchObject({ code: 'CLASSIFIER_BUSY' });
    await expect(classifier.classify('eve', 'laptop')).rejects.toMatchObject({ code: 'CLASSIFIER_BUSY' });
    finish(); await Promise.all(active);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it('caps actual upstream calls at 500 per process per day without charging cache hits', async () => {
    let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response());
    const classifier = new InstantClassifier(config(), fetcher);
    for (let i = 0; i < 500; i++) await classifier.classify('owner', `laptop ${i}`);
    await classifier.classify('owner', 'laptop 499');
    await expect(classifier.classify('owner', 'laptop 500')).rejects.toMatchObject({ code: 'CLASSIFIER_LIMIT' });
    expect(fetcher).toHaveBeenCalledTimes(500);
    now += 86400001;
    await classifier.classify('owner', 'laptop 500');
    expect(fetcher).toHaveBeenCalledTimes(501);
  });
  it.each([401, 403, 429, 500])('redacts upstream errors and never retries HTTP %i', async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('private token and draft', { status }));
    await expect(new InstantClassifier(config(), fetcher).classify('owner', 'laptop')).rejects.toMatchObject({ code: 'CLASSIFIER_UNAVAILABLE' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('rejects malformed and unsuccessful provider data without returning it', async () => {
    for (const body of ['not JSON', JSON.stringify({ success: false }), JSON.stringify({ success: true, result: { response: { ...hint, unexpected: 'private' } } })]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
      await expect(new InstantClassifier(config(), fetcher).classify('owner', 'laptop')).rejects.toMatchObject({ code: 'CLASSIFIER_INVALID_DATA' });
    }
  });
  it('passes cancellation to Cloudflare and skips already cancelled drafts', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    }));
    const classifier = new InstantClassifier(config(), fetcher);
    const result = classifier.classify('owner', 'laptop', controller.signal);
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: 'CLASSIFIER_UNAVAILABLE' });
    await expect(classifier.classify('owner', 'laptop', controller.signal)).rejects.toMatchObject({ code: 'CLASSIFIER_CANCELLED' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('is disabled without credentials, when opted out, and in scripted demo mode', async () => {
    for (const setting of [settings({}), { ...config(), CLOUDFLARE_API_TOKEN: '' }, { ...config(), FAIRBUY_MODE: 'demo' as const }, { ...config(), INSTANT_CLASSIFIER_PROVIDER: 'disabled' as const }]) {
      const fetcher = vi.fn<typeof fetch>(); const classifier = new InstantClassifier(setting, fetcher);
      expect(classifier.configured()).toBe(false);
      await expect(classifier.classify('owner', 'laptop')).rejects.toMatchObject({ code: 'CLASSIFIER_UNAVAILABLE' });
      expect(fetcher).not.toHaveBeenCalled();
    }
  });
});

describe('instant-classifier HTTP boundary', () => {
  function setup(password = '') {
    const configuration = { ...config(), APP_ACCESS_TOKEN: password };
    const store = new MemoryStore();
    const classifier = new InstantClassifier(configuration, vi.fn<typeof fetch>().mockImplementation(async () => response()));
    const classify = vi.spyOn(classifier, 'classify');
    const app = createApp(new ShoppingService(store, new DemoAIProvider(), 'live'), configuration, undefined, classifier);
    return { app, classify };
  }
  it('requires app access and CSRF verification before calling the provider', async () => {
    const { app, classify } = setup('private-password'); const client = request.agent(app);
    expect((await client.get('/api/bootstrap')).body.instantClassifierConfigured).toBe(false);
    await client.post('/api/instant-classifier').send({ text: 'laptop' }).expect(403);
    await client.post('/api/instant-classifier').set('X-Fairbuy-Request', '1').send({ text: 'laptop' }).expect(401);
    expect(classify).not.toHaveBeenCalled();
    await client.post('/api/access').set('X-Fairbuy-Request', '1').send({ token: 'private-password' }).expect(200);
    const bootstrap = (await client.get('/api/bootstrap')).body;
    expect(bootstrap.instantClassifierConfigured).toBe(true);
    expect(JSON.stringify(bootstrap)).not.toContain('test-only-cloudflare-token');
    await client.post('/api/instant-classifier').set('X-Fairbuy-Request', '1').set('Origin', 'https://attacker.invalid').send({ text: 'laptop' }).expect(403);
    const preview = await client.post('/api/instant-classifier').set('X-Fairbuy-Request', '1').send({ text: 'laptop' }).expect(200);
    expect(preview.body).toEqual(hint);
    expect(preview.headers['cache-control']).toBe('no-store');
    expect((await client.get('/api/bootstrap')).body.session).toBeNull();
  });
  it('rejects invalid input and separately limits preview requests', async () => {
    const { app, classify } = setup(); const client = request.agent(app);
    await client.get('/api/bootstrap');
    for (const body of [{ text: 'ab' }, { text: 'a'.repeat(3001) }, { text: 'laptop', url: 'http://localhost' }]) {
      await client.post('/api/instant-classifier').set('X-Fairbuy-Request', '1').send(body).expect(400);
    }
    expect(classify).not.toHaveBeenCalled();
    for (let i = 0; i < 17; i++) await client.post('/api/instant-classifier').set('X-Fairbuy-Request', '1').send({ text: 'laptop' }).expect(200);
    const limited = await client.post('/api/instant-classifier').set('X-Fairbuy-Request', '1').send({ text: 'laptop' }).expect(429);
    expect(limited.body.code).toBe('CLASSIFIER_LIMIT');
    await client.post('/api/sessions').set('X-Fairbuy-Request', '1').expect(201);
  });
});
