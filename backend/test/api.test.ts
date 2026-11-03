import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { DemoAIProvider } from '../src/ai/demo';
import { LiveAIProvider } from '../src/ai/provider';
import { MemoryStore } from '../src/store';
import { ShoppingService } from '../src/shopping-service';
import { settings } from '../src/settings';
import { ConfigSchema, RANKING_VERSION, formatQuestionAnswer } from '@fairbuy/core';
import { ProductImageResolver } from '../src/product-image-resolver';
import { logger } from '../src/logger';
import { randomUUID } from 'node:crypto';
import { recordDiagnostic } from '../src/diagnostics';
import * as imageProxy from '../src/image-proxy';

function setup(extra: Record<string, string> = {}) {
  const config = settings({ NODE_ENV: 'test', FAIRBUY_MODE: 'demo', ...extra });
  const store = new MemoryStore();
  const ai = config.FAIRBUY_MODE === 'demo' ? new DemoAIProvider() : new LiveAIProvider(config);
  const service = new ShoppingService(store, ai, config.FAIRBUY_MODE);
  const app = createApp(service, config);
  return { app, store, service };
}
describe('product image recovery and browser diagnostics', () => {
  it('correlates proxy, recovery and browser failures while enforcing search ownership', async () => {
    const { app, store, service } = setup(); const client = request.agent(app); const other = request.agent(app);
    const send = (path: string, body?: object) => client.post(path).set('X-Fairbuy-Request', '1').send(body);
    const created = (await send('/api/sessions')).body;
    await send(`/api/sessions/${created.id}/ask`, { message: 'Laptop for coding in Italy' });
    await send(`/api/sessions/${created.id}/discovery`);
    await service.runJob((await store.claim())!);
    await store.append(created.id, null, session => { session.rounds[0].products[0].imageUrl = 'https://images.seller-cdn.org/dead.png'; });
    const saved = await store.get(created.id); const product = saved.rounds[0].products[0]; const traceId = randomUUID();
    const proxy = vi.spyOn(imageProxy, 'getPublicImage').mockResolvedValue(null);
    const resolve = vi.spyOn(ProductImageResolver.prototype, 'get').mockImplementation(async () => {
      recordDiagnostic('image.fetch.unavailable', 'warn', { domain: 'images.seller-cdn.org', status: 403, reason: 'http_status' });
      return null;
    });
    const log = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const initial = `/api/image?${new URLSearchParams({ url: product.imageUrl!, sessionId: saved.id, productId: product.id, traceId })}`;
      const recovery = `/api/sessions/${saved.id}/products/${product.id}/image?traceId=${traceId}`;
      await other.get(initial).expect(404);
      await other.get(recovery).expect(404);
      expect(proxy).not.toHaveBeenCalled(); expect(resolve).not.toHaveBeenCalled();
      expect((await client.get(initial).expect(404)).headers['x-trace-id']).toBe(traceId);
      const response = await client.get(recovery).expect(404);
      expect(response.body.traceId).toBe(traceId);
      const report = { kind: 'image_unavailable', sessionId: saved.id, productId: product.id, traceId };
      await other.post('/api/client-events').set('X-Fairbuy-Request', '1').send(report).expect(404);
      await send('/api/client-events', report).expect(204);
      await send('/api/client-events', report).expect(204);
      const trace = await service.diagnostics.list({ page: 1, traceId });
      expect(trace.events.filter(e => e.event === 'image.request.started')).toHaveLength(2);
      expect(trace.events.filter(e => e.event === 'image.request.started').map(e => e.details.operation)).toEqual(['proxy', 'recovery']);
      expect(trace.events.filter(e => e.event === 'client.image_unavailable')).toHaveLength(1);
      expect(trace.events.find(e => e.event === 'image.fetch.unavailable')?.details.status).toBe(403);
      expect(trace.events.every(e => e.traceId === traceId && e.sessionId === saved.id && e.roundId === saved.rounds[0].id && e.productId === product.id)).toBe(true);
      expect(JSON.stringify(trace)).not.toContain(product.imageUrl);
      await client.get(`${recovery}not-a-uuid`).expect(400);
      await request(app).get('/api/admin/diagnostics').expect(503);
    } finally { proxy.mockRestore(); resolve.mockRestore(); log.mockRestore(); }
  });
  it('serves recovered images for an owned saved product, including older rounds', async () => {
    const { app, store, service } = setup(); const client = request.agent(app);
    const send = (path: string, body?: object) => client.post(path).set('X-Fairbuy-Request', '1').send(body);
    const { body: created } = await send('/api/sessions');
    await send(`/api/sessions/${created.id}/ask`, { message: 'A laptop for coding in Italy' });
    await send(`/api/sessions/${created.id}/discovery`);
    await service.runJob((await store.claim())!);
    const saved = await store.get(created.id);
    const product = saved.rounds[0].products[0];
    expect(product.imageUrl).toBeNull();
    const resolve = vi.spyOn(ProductImageResolver.prototype, 'get').mockResolvedValue({ body: Buffer.from('test-image'), contentType: 'image/png' });
    try {
      const path = `/api/sessions/${created.id}/products/${product.id}/image`;
      await request(app).get(path).expect(404);
      expect(resolve).not.toHaveBeenCalled();
      const response = await client.get(path).expect(200);
      expect(response.headers['content-type']).toBe('image/png');
      expect(response.headers['cache-control']).toBe('private, max-age=3600');
      expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ id: product.id, imageUrl: null }));
      await client.get(`/api/sessions/${created.id}/products/unknown/image`).expect(404);
      // A newer empty round must not make earlier products inaccessible.
      await send(`/api/sessions/${created.id}/discovery`);
      await client.get(path).expect(200);
      resolve.mockResolvedValueOnce(null);
      const unavailable = await client.get(path).expect(404);
      expect(unavailable.body.code).toBe('IMAGE_UNAVAILABLE');
      expect(unavailable.headers['cache-control']).toBe('no-store');
    } finally { resolve.mockRestore(); }
  });

  it('accepts bounded browser error metadata but refuses console text and URLs', async () => {
    const { app } = setup(); const client = request.agent(app);
    const log = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const event = { kind: 'runtime_error', errorType: 'TypeError', asset: '/assets/index-abcd.js', line: 4, column: 20 };
    const post = (body: object) => client.post('/api/client-events').set('X-Fairbuy-Request', '1').send(body);
    try {
      await client.post('/api/client-events').send(event).expect(403);
      await post(event).expect(204);
      expect(log).toHaveBeenCalledWith('client.error', { ...event, traceId: expect.any(String) });
      await post({ ...event, message: 'private chat text' }).expect(400);
      await post({ ...event, asset: 'https://seller.org/private?token=secret' }).expect(400);
      await post({ kind: 'unhandled_rejection', errorType: 'UnknownError' }).expect(204);
      await post({ kind: 'image_unavailable', sessionId: 'c6684151-7c26-4dbd-9173-c45d8c9ceab4', productId: 'test-product' }).expect(404);
      const gated = request(createApp(new ShoppingService(new MemoryStore(), new DemoAIProvider(), 'demo'), settings({ APP_ACCESS_TOKEN: 'private' })));
      await gated.post('/api/client-events').set('X-Fairbuy-Request', '1').send(event).expect(401);
    } finally { log.mockRestore(); }
  });
});
describe('missing product questions (issue #23)', () => {
  it('answers from the latest round, keeps the answer and validates the question', async () => {
    const { app, store, service } = setup(); const client = request.agent(app);
    const send = (path: string, body?: object) => client.post(path).set('X-Fairbuy-Request', '1').send(body);
    const { body: created } = await send('/api/sessions');
    await send(`/api/sessions/${created.id}/missing`, { query: 'Moss Book 14' }).expect(409);
    await send(`/api/sessions/${created.id}/ask`, { message: 'A laptop for coding' });
    await send(`/api/sessions/${created.id}/ask`, { message: 'Italy, budget €700' });
    await send(`/api/sessions/${created.id}/discovery`).expect(202);
    await service.runJob((await store.claim())!);
    await send(`/api/sessions/${created.id}/missing`, { query: 'x' }).expect(400);
    await send(`/api/sessions/${created.id}/missing`, { query: 'Moss Book 14', extra: true }).expect(400);
    const { body } = await send(`/api/sessions/${created.id}/missing`, { query: 'Omega Speedmaster' }).expect(200);
    const asked = body.rounds.at(-1).missingQuestions;
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ query: 'Omega Speedmaster', cause: 'not_retrieved', summary: 'It is not in the synthetic demo catalog.' });
    expect((await store.get(created.id)).rounds.at(-1)?.missingQuestions?.[0].at).toEqual(expect.any(String));
  });
});

describe('Ask question cards (issue #17)', () => {
  it('returns the optional structured question with the assistant message', async () => {
    const { app, service } = setup(); const client = request.agent(app);
    const send = (path: string, body?: object) => client.post(path).set('X-Fairbuy-Request', '1').send(body);
    const { body: created } = await send('/api/sessions');
    const question = {
      prompt: 'What condition are you open to?',
      options: [{ id: 'new', label: 'New only' }, { id: 'used', label: 'Used is fine' }],
      multiSelect: false, allowFreeText: true,
    };
    vi.spyOn(service.ai, 'converse').mockResolvedValueOnce({ reply: 'Choose one.', config: created.config, ready: false, missing: [], question });
    const { body } = await send(`/api/sessions/${created.id}/ask`, { message: 'A used one is fine' }).expect(200);
    expect(body.askMessages.at(-1)).toMatchObject({ role: 'assistant', content: 'Choose one.', question });
    expect(body.askMessages.at(-1).question.options).toHaveLength(2);
  });

  it('restores one persisted card through bootstrap and applies its answer like a typed message', async () => {
    const { app, store, service } = setup(); const client = request.agent(app);
    const send = (path: string, body?: object) => client.post(path).set('X-Fairbuy-Request', '1').send(body);
    const creation = await send('/api/sessions').expect(201);
    const created = creation.body;
    const cookie = (creation.headers['set-cookie'] as unknown as string[]).find(value => value.startsWith('fairbuy_owner='))!.split(';')[0];
    const question = {
      prompt: 'What condition are you open to?',
      options: [{ id: 'new', label: 'New only' }, { id: 'used', label: 'Used is fine' }],
      multiSelect: false, allowFreeText: true,
    };
    const config = { ...created.config, category: 'laptop', purpose: 'coding', country: 'IT' };
    const converse = vi.spyOn(service.ai, 'converse').mockResolvedValueOnce({
      reply: 'Choose one.', config, ready: false, missing: [], question,
    });
    await send(`/api/sessions/${created.id}/ask`, { message: 'Laptop for coding in Italy' }).expect(200);
    const restored = (await client.get('/api/bootstrap').expect(200)).body.session;
    expect(restored.askMessages).toEqual([
      { role: 'user', content: 'Laptop for coding in Italy' },
      { role: 'assistant', content: 'Choose one.', question },
    ]);

    const updatedConfig = ConfigSchema.parse({ ...config, requirements: [
      { label: 'New only with warranty', hard: true, attribute: 'condition', op: '=', value: 'new', unit: null },
    ] });
    const answer = formatQuestionAnswer(question.options, ['new'], 'with warranty');
    converse.mockResolvedValueOnce({ reply: 'Noted.', config: updatedConfig, ready: true, missing: [] });
    await send(`/api/sessions/${created.id}/ask`, { message: answer }).expect(200);
    expect(converse).toHaveBeenLastCalledWith('ask', [
      ...restored.askMessages, { role: 'user', content: 'New only — with warranty' },
    ], config);

    // A fresh app instance reads the store, rather than an intercepted bootstrap response.
    const reloaded = await request(createApp(new ShoppingService(store, new DemoAIProvider(), 'demo'), settings({ NODE_ENV: 'test', FAIRBUY_MODE: 'demo' })))
      .get('/api/bootstrap').set('Cookie', cookie).expect(200);
    const final = reloaded.body.session;
    expect(final.config).toEqual(updatedConfig);
    expect(final.askMessages).toEqual([
      ...restored.askMessages,
      { role: 'user', content: answer }, { role: 'assistant', content: 'Noted.' },
    ]);
    expect((await client.get(`/api/sessions/${created.id}`).expect(200)).body.askMessages).toEqual(final.askMessages);
  });
});

describe('stored rankings', () => {
  it('serves sessions with rankings recomputed by the current version, not the stored snapshot', async () => {
    const { app, store, service } = setup(); const client = request.agent(app);
    const send = (method: 'post' | 'get', path: string, body?: object) => client[method](path).set('X-Fairbuy-Request', '1').send(body);
    const { body: created } = await send('post', '/api/sessions');
    await send('post', `/api/sessions/${created.id}/ask`, { message: 'A laptop for coding' });
    await send('post', `/api/sessions/${created.id}/ask`, { message: 'Italy, budget €700' });
    await send('post', `/api/sessions/${created.id}/discovery`).expect(202);
    await service.runJob((await store.claim())!);
    expect((await store.get(created.id)).rounds.at(-1)?.status).toBe('complete');
    // A snapshot written before ranking 3.0.0 has no weights and an old version.
    const original = store.get.bind(store);
    vi.spyOn(store, 'get').mockImplementation(async (...args) => {
      const session = await original(...args);
      for (const round of session.rounds) {
        if (round.ranking) round.ranking = { ...round.ranking, rankingVersion: '2.0.0', ranked: round.ranking.ranked.map(({ weights: _, ...rest }) => rest as typeof rest & { weights: never }) };
      }
      return session;
    });
    const { body } = await send('get', `/api/sessions/${created.id}`).expect(200);
    const ranking = body.rounds.at(-1).ranking;
    expect(ranking.rankingVersion).toBe(RANKING_VERSION);
    expect(ranking.ranked.length).toBeGreaterThan(0);
    expect(ranking.ranked.every((r: { weights?: object }) => r.weights)).toBe(true);
  });
});
describe('health endpoints', () => {
  it.each(['/health'])('%s reports readiness without a password or AI key', async path => {
    const { app, store } = setup({ FAIRBUY_MODE: 'live', MODEL_API_KEY: '', APP_ACCESS_TOKEN: 'test-only-access' });
    const health = vi.spyOn(store, 'health');
    const response = await request(app).get(path).expect('Content-Type', /json/).expect(200);
    expect(response.body).toEqual({ status: 'ok' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(health).toHaveBeenCalledOnce();
  });
  it('/healthz reports liveness without touching the database', async () => {
    const { app, store } = setup({ FAIRBUY_MODE: 'live', MODEL_API_KEY: '', APP_ACCESS_TOKEN: 'test-only-access' });
    const health = vi.spyOn(store, 'health');
    const response = await request(app).get('/healthz').expect('Content-Type', /json/).expect(200);
    expect(response.body).toEqual({ status: 'ok' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(health).not.toHaveBeenCalled();
  });
  it('/health returns 503 before migrations complete', async () => {
    const { app } = setup({ APP_ACCESS_TOKEN: 'test-only-access' });
    const notReady = createApp(new ShoppingService(new MemoryStore(), new DemoAIProvider(), 'demo'), settings({ NODE_ENV: 'test', FAIRBUY_MODE: 'demo' }), undefined, undefined, () => false);
    await request(notReady).get('/health').expect(503);
    await request(app).get('/health').expect(200);
  });
  it.each(['/health'])('%s returns 503 without leaking database errors', async path => {
    const { app, store } = setup({ APP_ACCESS_TOKEN: 'test-only-access' });
    vi.spyOn(store, 'health').mockRejectedValue(new Error('Private database connection details'));
    const response = await request(app).get(path).expect('Content-Type', /json/).expect(503);
    expect(response.body).toEqual({ status: 'unavailable' });
    expect(response.headers['cache-control']).toBe('no-store');
  });
});
describe('HTTP API security and validation', () => {
  it('sets an HttpOnly owner cookie and isolates two browsers', async () => {
    const { app } = setup(); const alice = request.agent(app); const bob = request.agent(app);
    const bootstrap = await alice.get('/api/bootstrap').expect(200);
    expect(bootstrap.headers['set-cookie'][0]).toContain('HttpOnly');
    expect(bootstrap.headers['cache-control']).toBe('no-store');
    const created = await alice.post('/api/sessions').set('X-Fairbuy-Request', '1').expect(201);
    await bob.get(`/api/sessions/${created.body.id}`).expect(404);
    await bob.delete(`/api/sessions/${created.body.id}`).set('X-Fairbuy-Request', '1').expect(204);
    await alice.get(`/api/sessions/${created.body.id}`).expect(200);
    expect((await alice.get('/api/bootstrap')).body.session.id).toBe(created.body.id);
  });
  it('blocks CSRF, invalid IDs, arbitrary URLs and oversized inputs', async () => {
    const { app } = setup(); const client = request.agent(app);
    await client.post('/api/sessions').expect(403);
    await client.post('/api/sessions').set('X-Fairbuy-Request', '1').set('Origin', 'https://attacker.invalid').expect(403);
    await client.get('/api/sessions/not-a-uuid').expect(400);
    await client.get('/api/fetch?url=http://127.0.0.1').expect(404);
    const { body: session } = await client.post('/api/sessions').set('X-Fairbuy-Request', '1');
    await client.post(`/api/sessions/${session.id}/ask`).set('X-Fairbuy-Request', '1').send({ message: 'x'.repeat(3001) }).expect(400);
    await client.post(`/api/sessions/${session.id}/ask`).set('X-Fairbuy-Request', '1').set('Content-Type', 'application/json').send('{invalid').expect(400);
    await client.post(`/api/sessions/${session.id}/ask`).set('X-Fairbuy-Request', '1').send({ message: 'x'.repeat(40000) }).expect(400);
  });
  it('gates provider-spending endpoints behind the deployment token', async () => {
    const { app } = setup({ APP_ACCESS_TOKEN: 'test-only-access' }); const client = request.agent(app);
    expect((await client.get('/api/bootstrap')).body.accessRequired).toBe(true);
    await client.post('/api/sessions').set('X-Fairbuy-Request', '1').expect(401);
    await client.post('/api/access').set('X-Fairbuy-Request', '1').send({ token: 'wrong' }).expect(401);
    await client.post('/api/access').set('X-Fairbuy-Request', '1').send({ token: 'test-only-access' }).expect(200);
    expect((await client.get('/api/bootstrap')).body.accessRequired).toBe(false);
    await client.post('/api/sessions').set('X-Fairbuy-Request', '1').expect(201);
  });
  it('rejects private image-proxy targets', async () => {
    const { app } = setup(); const client = request.agent(app);
    await client.get('/api/image').expect(400);
    await client.get('/api/image?url=http://127.0.0.1/x.jpg').expect(400);
    await client.get('/api/image?url=https://127.0.0.1/x.jpg').expect(400);
    await client.get('/api/image?url=https://localhost/x.jpg').expect(400);
  });
  it('starts without a key but never falls back to a demo', async () => {
    const { app } = setup({ FAIRBUY_MODE: 'live', MODEL_API_KEY: '' }); const client = request.agent(app);
    const boot = (await client.get('/api/bootstrap')).body;
    expect(boot.aiConfigured).toBe(false); expect(boot.mode).toBe('live');
    const { body } = await client.post('/api/sessions').set('X-Fairbuy-Request', '1');
    const error = await client.post(`/api/sessions/${body.id}/ask`).set('X-Fairbuy-Request', '1').send({ message: 'laptop' }).expect(503);
    expect(error.body.code).toBe('AI_NOT_CONFIGURED');
    expect((await client.get(`/api/sessions/${body.id}`)).body.askMessages).toEqual([]);
    await client.get('/healthz').expect(200);
  });
});
