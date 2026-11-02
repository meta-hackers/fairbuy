import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { DemoAIProvider } from '../src/ai/demo';
import { LiveAIProvider } from '../src/ai/provider';
import { MemoryStore } from '../src/store';
import { ShoppingService } from '../src/shopping-service';
import { settings } from '../src/settings';
import { RANKING_VERSION } from '@fairbuy/core';

function setup(extra: Record<string, string> = {}) {
  const config = settings({ NODE_ENV: 'test', FAIRBUY_MODE: 'demo', ...extra });
  const store = new MemoryStore();
  const ai = config.FAIRBUY_MODE === 'demo' ? new DemoAIProvider() : new LiveAIProvider(config);
  const service = new ShoppingService(store, ai, config.FAIRBUY_MODE);
  const app = createApp(service, config);
  return { app, store, service };
}
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
