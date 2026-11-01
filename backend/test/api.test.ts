import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { DemoAIProvider } from '../src/ai/demo';
import { LiveAIProvider } from '../src/ai/provider';
import { MemoryStore } from '../src/store';
import { ShoppingService } from '../src/shopping-service';
import { settings } from '../src/settings';

function setup(extra: Record<string, string> = {}) {
  const config = settings({ NODE_ENV: 'test', FAIRBUY_MODE: 'demo', ...extra });
  const store = new MemoryStore();
  const ai = config.FAIRBUY_MODE === 'demo' ? new DemoAIProvider() : new LiveAIProvider(config);
  const app = createApp(new ShoppingService(store, ai, config.FAIRBUY_MODE), config);
  return { app, store };
}
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
