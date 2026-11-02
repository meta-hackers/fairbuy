import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { passwordHash, verifyPassword } from '../src/admin';
import { MemoryStore } from '../src/store';
import { SourceCatalogService } from '../src/source-catalog';
import { SOURCE_CATALOG_SEED } from '../../data/source-catalog';
import { DemoAIProvider } from '../src/ai/demo';
import { ShoppingService } from '../src/shopping-service';
import { settings } from '../src/settings';
import { recordUsage } from '../src/usage';

let hash: string;
beforeAll(async () => { hash = await passwordHash('test-password-not-for-production'); });
function setup(enabled = true, appPassword = '', catalog?: SourceCatalogService) {
  const config = settings({ NODE_ENV: 'test', FAIRBUY_MODE: 'demo', APP_ACCESS_TOKEN: appPassword, BACKOFFICE_ADMINS: JSON.stringify(enabled ? [{ username: 'Alberto', passwordHash: hash }, { username: 'OtherAdmin', passwordHash: hash }] : []) });
  const store = new MemoryStore(); const service = new ShoppingService(store, new DemoAIProvider(), 'demo');
  const app = createApp(service, config, undefined, undefined, undefined, catalog);
  return { app, service, config };
}
const write = { 'X-Fairbuy-Request': '1' };
const catalogEnvelope = (entries: unknown[]) => ({ schemaVersion: 1, updatedAt: new Date().toISOString(), entries });
const catalogResponse = (entries: unknown[]) => new Response(JSON.stringify(catalogEnvelope(entries)), { status: 200, headers: { 'Content-Type': 'application/json' } });
async function login(client: ReturnType<typeof request.agent>, username = 'Alberto') {
  return client.post('/api/admin/login').set(write).send({ username, password: 'test-password-not-for-production' }).expect(200);
}
describe('backoffice authentication and authorization', () => {
  it('logs in with plaintext environment configuration without returning the password', async () => {
    const config = settings({ NODE_ENV: 'test', FAIRBUY_MODE: 'demo', BACKOFFICE_ADMINS: JSON.stringify([{ username: 'PlainAdmin', password: 'test-only-plain-password' }]) });
    const app = createApp(new ShoppingService(new MemoryStore(), new DemoAIProvider(), 'demo'), config);
    const client = request.agent(app);
    const login = await client.post('/api/admin/login').set(write).send({ username: 'PlainAdmin', password: 'test-only-plain-password' }).expect(200);
    expect(login.body).toEqual({ username: 'PlainAdmin' });
    const me = await client.get('/api/admin/me').expect(200);
    expect(JSON.stringify(me.body)).not.toContain('test-only-plain-password');
    expect(JSON.stringify(me.body)).not.toContain('scrypt:');
  });
  it('stores salted scrypt hashes and checks passwords', async () => {
    expect(await verifyPassword('test-password-not-for-production', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
    expect(await passwordHash('test-password-not-for-production')).not.toBe(hash);
  });
  it('fails closed without administrators and protects every admin endpoint', async () => {
    await request(setup(false).app).get('/api/admin/sessions').expect(503);
    const { app } = setup();
    await request(app).get('/api/admin/sessions').expect(401);
    await request(app).get('/api/admin/me').expect(401);
    await request(app).post('/api/admin/login').set(write).send({ username: 'Alberto', password: 'wrong' }).expect(401);
    await request(app).post('/api/admin/login').set(write).send({ username: 'Missing', password: 'wrong' }).expect(401);
  });
  it('requires CSRF verification and rejects cross-origin logins', async () => {
    const { app } = setup();
    await request(app).post('/api/admin/login').send({ username: 'Alberto', password: 'test-password-not-for-production' }).expect(403);
    await request(app).post('/api/admin/login').set(write).set('Origin', 'https://attacker.invalid').send({ username: 'Alberto', password: 'test-password-not-for-production' }).expect(403);
  });
  it('allows distinct admins, uses strict cookies, revokes logout, and does not grant shopping access', async () => {
    const { app } = setup(true, 'separate-shopping-password');
    const alberto = request.agent(app); const other = request.agent(app);
    const response = await login(alberto, 'alberto');
    const cookie = (response.headers['set-cookie'] as unknown as string[]).find(value => value.startsWith('fairbuy_admin='))!;
    expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('SameSite=Strict'); expect(cookie).toContain('Path=/api/admin');
    expect((await alberto.get('/api/admin/me').expect(200)).body.username).toBe('Alberto');
    await login(other, 'OtherAdmin');
    expect((await other.get('/api/admin/me').expect(200)).body.username).toBe('OtherAdmin');
    await alberto.post('/api/sessions').set(write).expect(401);
    await alberto.post('/api/admin/logout').set(write).expect(204);
    await alberto.get('/api/admin/sessions').expect(401);
    await request(app).get('/api/admin/me').set('Cookie', cookie.split(';')[0]).expect(401);
    await other.get('/api/admin/me').expect(200);
  });
  it('invalidates existing sessions when an administrator is revoked', async () => {
    const { app, config } = setup(); const client = request.agent(app); await login(client);
    config.BACKOFFICE_ADMINS.splice(0, 1);
    await client.get('/api/admin/me').expect(401);
  });
  it('rate limits failed logins', async () => {
    const { app } = setup();
    for (let i = 0; i < 10; i++) await request(app).post('/api/admin/login').set(write).send({ username: 'Alberto', password: 'wrong' }).expect(401);
    await request(app).post('/api/admin/login').set(write).send({ username: 'Alberto', password: 'wrong' }).expect(429);
  });
});
describe('backoffice session data', () => {
  it('shows all owners only to admins, supports filters, and preserves complete detail', async () => {
    const { app, service } = setup();
    const first = await service.create('first-browser'); const second = await service.create('second-browser');
    await service.message(first.id, 'first-browser', 'ask', 'Laptop for coding in Italy, budget €700');
    const client = request.agent(app); await login(client);
    const response = await client.get('/api/admin/sessions').expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.total).toBe(2);
    expect(response.body.sessions.map((s: any) => s.owner)).toEqual(expect.arrayContaining(['first-browser', 'second-browser']));
    expect((await client.get('/api/admin/sessions?search=Laptop&mode=demo').expect(200)).body.total).toBe(1);
    expect((await client.get('/api/admin/sessions?stage=buy').expect(200)).body.total).toBe(0);
    const detail = await client.get(`/api/admin/sessions/${first.id}`).expect(200);
    expect(detail.body.session.askMessages).toHaveLength(2);
    expect(detail.body.summary.inputTokens).toBeNull();
    expect(JSON.stringify(detail.body)).not.toContain(hash);
    await client.get('/api/admin/sessions?page=0').expect(400);
    await client.get('/api/admin/sessions/not-a-uuid').expect(400);
    await client.post(`/api/admin/sessions/${second.id}`).set(write).send({}).expect(404);
    await service.store.archive(first.id, 'first-browser');
    await client.get(`/api/admin/sessions/${first.id}`).expect(200);
    const history = await client.get(`/api/admin/sessions/${first.id}/history`).expect(200);
    expect(history.body.revisions.at(-1)).toMatchObject({ kind: 'archived', archived: true });
    expect((await client.get('/api/admin/me')).body.retentionDays).toBeNull();
  });
  it('returns per-call usage without exposing prompts and includes partial totals', async () => {
    const { app, service } = setup(); const s = await service.create('owner');
    await service.usage.capture(s.id, 'ask', null, async () => {
      recordUsage('meta', 'model', 'generation', 'completed', 100, { input_tokens: 100, output_tokens: 40 }, { model: { input: 1, output: 3 } });
      recordUsage('meta', 'model', 'generation', 'failed', 50);
    });
    const client = request.agent(app); await login(client);
    const { body } = await client.get(`/api/admin/sessions/${s.id}`).expect(200);
    expect(body.usage).toHaveLength(2);
    expect(body.summary).toMatchObject({ calls: 2, inputTokens: 100, outputTokens: 40, partial: true });
    expect(body.summary.estimatedCostUsd).toBeCloseTo(0.00022);
  });
  it('allows permanent deletion only through authenticated, confirmed maintenance', async () => {
    const { app, service } = setup(); const s = await service.create('owner');
    await service.usage.capture(s.id, 'ask', null, async () => { recordUsage('meta', 'm', 'generation', 'completed', 1); });
    const path = `/api/admin/sessions/${s.id}/purge`;
    await request(app).post(path).set(write).send({ confirmSessionId: s.id }).expect(401);
    await request(app).get(`/api/admin/sessions/${s.id}/history`).expect(401);
    const client = request.agent(app); await login(client);
    await client.post(path).send({ confirmSessionId: s.id }).expect(403);
    await client.post(path).set(write).set('Origin', 'https://attacker.invalid').send({ confirmSessionId: s.id }).expect(403);
    await client.post(path).set(write).send({}).expect(400);
    await client.post(path).set(write).send({ confirmSessionId: '00000000-0000-4000-8000-000000000000' }).expect(400);
    await client.get(`/api/admin/sessions/${s.id}`).expect(200);
    await client.post(path).set(write).send({ confirmSessionId: s.id }).expect(204);
    await client.get(`/api/admin/sessions/${s.id}`).expect(404);
    expect(await service.usage.get(s.id)).toEqual([]);
  });
  it('serves the bundled catalog and syncs the published JSON on admin request', async () => {
    const remote = [
      { domain: 'remote.ch', name: 'Remote', roles: ['seller'], verticals: ['computers'], countries: ['CH'], priority: 3 },
      { domain: 'spec.ch', name: 'Spec', roles: ['spec'], verticals: ['computers'], countries: 'global', priority: 2 },
    ];
    const catalog = new SourceCatalogService(
      { CATALOG_URL: 'https://example.test/sources.json' },
      vi.fn<typeof fetch>().mockResolvedValue(catalogResponse(remote)),
    );
    const { app } = setup(true, '', catalog);
    const client = request.agent(app); await login(client);
    const initial = await client.get('/api/admin/sources').expect(200);
    expect(initial.body).toMatchObject({ source: 'fallback', error: null });
    expect(initial.body.entries).toHaveLength(SOURCE_CATALOG_SEED.length);
    expect(initial.body.entries.find((entry: any) => entry.domain === 'ricardo.ch')).toMatchObject({ name: 'Ricardo' });
    expect(initial.body.roles).toContain('seller');
    expect(initial.body.verticals).toContain('food_delivery');

    const synced = await client.post('/api/admin/sources/sync').set(write).send({}).expect(200);
    expect(synced.body).toMatchObject({ source: 'github', count: 2, error: null });
    expect(synced.body.entries.map((entry: any) => entry.domain)).toEqual(['remote.ch', 'spec.ch']);
    const status = await client.get('/api/admin/sources').expect(200);
    expect(status.body).toMatchObject({ source: 'github', count: 2 });
  });
  it('keeps the bundled catalog when the published JSON cannot be loaded', async () => {
    const catalog = new SourceCatalogService(
      { CATALOG_URL: 'https://example.test/sources.json' },
      vi.fn<typeof fetch>().mockResolvedValue(new Response('no', { status: 503 })),
    );
    const { app } = setup(true, '', catalog);
    const client = request.agent(app); await login(client);
    const synced = await client.post('/api/admin/sources/sync').set(write).send({}).expect(200);
    expect(synced.body).toMatchObject({ source: 'fallback', count: SOURCE_CATALOG_SEED.length });
    expect(synced.body.error).toContain('request failed');
    expect(synced.body.entries).toHaveLength(SOURCE_CATALOG_SEED.length);
  });
  it('requires admin authentication and request verification for catalog sync', async () => {
    const { app } = setup();
    await request(app).get('/api/admin/sources').expect(401);
    await request(app).post('/api/admin/sources/sync').set(write).send({}).expect(401);
    const client = request.agent(app); await login(client);
    await client.post('/api/admin/sources/sync').send({}).expect(403);
  });
  it('serves a separate static UI with safe headers and no public session data', async () => {
    const { app } = setup();
    await request(app).get('/backoffice').expect(302).expect('Location', '/backoffice/');
    const response = await request(app).get('/backoffice/').expect(200);
    expect(response.text).toContain('Session history');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-security-policy']).toContain("script-src 'self'");
    await request(app).get('/backoffice/app.js').expect(200);
    await request(app).get('/backoffice/.env.backoffice').expect(404);
  });
});
