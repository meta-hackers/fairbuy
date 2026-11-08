import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SourceEntrySchema, type SourceEntry } from '@fairbuy/core';
import { PostgresStore } from '../src/store';
import { DemoAIProvider } from '../src/ai/demo';
import { ShoppingService } from '../src/shopping-service';
import { UsageStore, recordUsage } from '../src/usage';
import { createApp } from '../src/app';
import { settings } from '../src/settings';
import { sessionStartup } from '../src/session-startup';
import { passwordHash } from '../src/admin';
import { DiagnosticStore, recordDiagnostic } from '../src/diagnostics';
import request from 'supertest';

describe.skipIf(!process.env.TEST_DATABASE_URL)('PostgreSQL persistence, ownership and durable jobs', () => {
  const url = process.env.TEST_DATABASE_URL!;
  let store: PostgresStore, second: PostgresStore;
  const owner = `test-${randomUUID()}`; const ids: string[] = [];
  beforeAll(async () => { store = new PostgresStore(url); second = new PostgresStore(url); await Promise.all([store.migrate(), second.migrate()]); });
  afterAll(async () => { for (const id of ids) await store.purge(id); await Promise.all([store.close(), second.close()]); });
  it('persists both price bounds in immutable session and discovery revisions', async () => {
    const service = new ShoppingService(store, new DemoAIProvider(), 'demo');
    const created = await service.create(owner); ids.push(created.id);
    const asked = await service.message(created.id, owner, 'ask', 'Laptop for coding in Italy, budget €700');
    await service.configure(created.id, owner, { ...asked.config, budgetMin: 400, budgetMax: 700, budgetHard: true });
    expect((await second.get(created.id, owner)).config).toMatchObject({ budgetMin: 400, budgetMax: 700 });
    await service.discover(created.id, owner);
    expect((await second.get(created.id, owner)).rounds.at(-1)?.context.config).toMatchObject({ budgetMin: 400, budgetMax: 700 });
    expect((await second.history(created.id)).some(revision => revision.session.config.budgetMin === 400)).toBe(true);
  });
  it('persists diagnostic traces across connections, deduplicates clients, keeps older data visible and cascades session purge', async () => {
    const service = new ShoppingService(store, new DemoAIProvider(), 'demo');
    const session = await service.create(owner); ids.push(session.id);
    const diagnostics = service.diagnostics, reader = new DiagnosticStore(second.pool); const traceId = randomUUID();
    const scope = { traceId, source: 'server' as const, sessionId: session.id, roundId: null, productId: 'product-a' };
    await diagnostics.capture(scope, async () => {
      recordDiagnostic('image.request.started', 'info');
      recordDiagnostic('image.fetch.unavailable', 'warn', { domain: 'seller.org', status: 403 });
      recordDiagnostic('image.request.completed', 'warn', { available: false });
    });
    const client = { ...scope, source: 'browser' as const, event: 'client.image_unavailable' as const, level: 'error' as const, details: {} };
    diagnostics.record(client); diagnostics.record(client); await diagnostics.flush();
    const trace = await reader.list({ page: 1, traceId });
    expect(trace.events.map(e => e.event)).toEqual(['image.request.started', 'image.fetch.unavailable', 'image.request.completed', 'client.image_unavailable']);
    expect(trace.events.every(e => e.sessionId === session.id)).toBe(true);
    expect((await reader.list({ page: 1, traceId, source: 'browser' })).total).toBe(1);
    await store.archive(session.id, owner);
    expect((await reader.list({ page: 1, traceId })).total).toBe(4);
    await store.pool.query("UPDATE diagnostic_events SET created_at = now() - interval '31 days' WHERE trace_id = $1 AND source = 'browser'", [traceId]);
    expect((await reader.list({ page: 1, traceId })).total).toBe(4);
    expect((await reader.list({ page: 1, traceId, source: 'browser' })).total).toBe(1);
    expect((await store.pool.query('SELECT id FROM diagnostic_events WHERE trace_id = $1', [traceId])).rowCount).toBe(4);
    await store.purge(session.id);
    expect((await reader.list({ page: 1, traceId })).total).toBe(0);
    diagnostics.record({ ...client, traceId: randomUUID() }); await diagnostics.flush();
    expect((await reader.list({ page: 1, sessionId: session.id })).total).toBe(0);
  });
  it('atomically persists startup settings and preserves them across mutations and migrations', async () => {
    const config = settings({ FAIRBUY_MODE: 'demo', ASK_MODEL: 'startup-model', DISCOVERY_REASONING_EFFORT: 'medium' });
    const service = new ShoppingService(store, new DemoAIProvider(), 'demo', undefined, config);
    const created = await service.create(owner); ids.push(created.id);
    const read = async () => (await second.pool.query('SELECT startup_config FROM shopping_sessions WHERE id = $1', [created.id])).rows[0].startup_config;
    expect(await read()).toEqual(sessionStartup(config));
    await service.message(created.id, owner, 'ask', 'Laptop for coding in Italy, budget €700');
    await second.migrate();
    expect(await read()).toEqual(sessionStartup(config));
  });
  it('persists the source catalog as a full replacement across connections', async () => {
    const first: SourceEntry[] = [
      SourceEntrySchema.parse({ domain: 'persisted-shop.ch', name: 'Persisted Shop', roles: ['seller'], verticals: ['computers'], countries: ['CH'], priority: 3 }),
      SourceEntrySchema.parse({ domain: 'persisted-spec.ch', name: 'Persisted Spec', roles: ['spec'], verticals: ['watches'], countries: 'global', priority: 2, enabled: false }),
    ];
    await store.replaceSourceCatalog({ entries: first, url: 'https://example.test/sources.json', fetchedAt: '2026-01-02T03:04:05.000Z', version: 'first-version' });
    expect(await second.loadSourceCatalog()).toEqual({
      entries: first, url: 'https://example.test/sources.json', fetchedAt: '2026-01-02T03:04:05.000Z', version: 'first-version',
    });

    const secondVersion: SourceEntry[] = [
      SourceEntrySchema.parse({ domain: 'only-shop.ch', name: 'Only Shop', roles: ['marketplace'], verticals: ['home'], countries: ['CH'], priority: 1 }),
    ];
    await second.replaceSourceCatalog({ entries: secondVersion, url: 'https://example.test/sources.json', fetchedAt: '2026-02-03T04:05:06.000Z', version: 'second-version' });
    expect((await store.loadSourceCatalog())?.entries).toEqual(secondVersion);
  });
  it('persists through a new repository connection and isolates owner queries', async () => {
    const service = new ShoppingService(store, new DemoAIProvider(), 'demo');
    const created = await service.create(owner); ids.push(created.id);
    await service.message(created.id, owner, 'ask', 'Laptop for coding in Italy, budget €700');
    expect((await second.get(created.id, owner)).ready).toBe(true);
    await expect(second.get(created.id, 'other-owner')).rejects.toMatchObject({ status: 404 });
    expect((await second.latest(owner))?.id).toBe(created.id);
  });
  it('restores Ask cards once across connections, including after a typed answer', async () => {
    const ai = new DemoAIProvider();
    const service = new ShoppingService(store, ai, 'demo');
    const created = await service.create(owner); ids.push(created.id);
    const question = {
      prompt: 'What condition are you open to?',
      options: [{ id: 'new', label: 'New only' }, { id: 'used', label: 'Used is fine' }],
      multiSelect: false, allowFreeText: true,
    };
    vi.spyOn(ai, 'converse').mockResolvedValueOnce({
      reply: 'Choose one.', config: created.config, ready: false, missing: [], question,
    });
    await service.message(created.id, owner, 'ask', 'Laptop for coding');
    const restored = await second.get(created.id, owner);
    expect(restored.askMessages).toEqual([
      { role: 'user', content: 'Laptop for coding' }, { role: 'assistant', content: 'Choose one.', question },
    ]);
    await new ShoppingService(second, new DemoAIProvider(), 'demo').message(created.id, owner, 'ask', 'New only');
    const answered = await store.get(created.id, owner);
    expect(answered.askMessages.filter(message => message.question)).toEqual([restored.askMessages[1]]);
    expect(answered.askMessages[2]).toEqual({ role: 'user', content: 'New only' });
  });
  it('persists usage and admin logins across app instances, and cascades usage on deletion', async () => {
    const usage = new UsageStore(store.pool);
    const service = new ShoppingService(store, new DemoAIProvider(), 'demo', usage);
    const created = await service.create(owner); ids.push(created.id);
    // Usage remains independent of the append transaction.
    await usage.capture(created.id, 'ask', null, () => store.append(created.id, owner, () => {
      recordUsage('meta', 'm', 'generation', 'completed', 10, { input_tokens: 200, output_tokens: 100 }, { '*': { input: 1, output: 3 } });
    }));
    expect((await new UsageStore(second.pool).get(created.id))[0]).toMatchObject({ inputTokens: 200, estimatedCostUsd: 0.0005 });
    expect((await second.listSessions({ search: created.id, stage: 'ask', mode: 'demo', page: 1 })).total).toBe(1);
    const config = settings({ NODE_ENV: 'test', BACKOFFICE_ADMINS: JSON.stringify([{ username: 'DatabaseAdmin', passwordHash: await passwordHash('db-test-only') }]) });
    const login = await request(createApp(service, config)).post('/api/admin/login').set('X-Fairbuy-Request', '1').send({ username: 'DatabaseAdmin', password: 'db-test-only' }).expect(200);
    const cookies = login.headers['set-cookie'] as unknown as string[];
    const cookie = cookies.find(value => value.startsWith('fairbuy_admin='))!.split(';')[0];
    const secondApp = createApp(new ShoppingService(second, new DemoAIProvider(), 'demo', new UsageStore(second.pool)), config);
    await request(secondApp).get('/api/admin/me').set('Cookie', cookie).expect(200);
    await request(secondApp).post('/api/admin/logout').set('Cookie', cookie).set('X-Fairbuy-Request', '1').expect(204);
    await request(secondApp).get('/api/admin/me').set('Cookie', cookie).expect(401);
    await store.archive(created.id, owner);
    expect(await usage.get(created.id)).toHaveLength(1);
    await store.purge(created.id);
    expect(await usage.get(created.id)).toEqual([]);
    await usage.capture(created.id, 'ask', null, async () => { recordUsage('meta', 'm', 'generation', 'failed', 5); });
    expect(await usage.get(created.id)).toEqual([]);
  });
  it('queues atomically, leases exclusively, recovers interruptions and deletes cascading data', async () => {
    const service = new ShoppingService(store, new DemoAIProvider(), 'demo');
    const created = await service.create(owner); ids.push(created.id);
    await service.message(created.id, owner, 'ask', 'Laptop for coding in Italy');
    await Promise.all([service.discover(created.id, owner), new ShoppingService(second, new DemoAIProvider(), 'demo').discover(created.id, owner)]);
    expect((await store.get(created.id, owner)).rounds).toHaveLength(1);
    const [a, b] = await Promise.all([store.claim(), second.claim()]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const job = a ?? b!;
    await store.pool.query("UPDATE discovery_jobs SET lease_until = now() - interval '1 second' WHERE id = $1", [job.id]);
    const recovered = await second.claim(); expect(recovered?.attempts).toBe(2);
    await new ShoppingService(second, new DemoAIProvider(), 'demo').runJob(recovered!);
    expect((await store.get(created.id)).rounds[0].status).toBe('complete');
    await store.purge(created.id);
    expect((await store.pool.query('SELECT id FROM discovery_jobs WHERE session_id = $1', [created.id])).rows).toEqual([]);
  });
  it('appends immutable snapshots without rewriting session identity or legacy children', async () => {
    const service = new ShoppingService(store, new DemoAIProvider(), 'demo');
    const created = await service.create(owner); ids.push(created.id);
    await service.message(created.id, owner, 'ask', 'Laptop for coding in Italy');
    await service.discover(created.id, owner);
    const job = await store.claim(); expect(job).not.toBeNull();
    await new ShoppingService(store, new DemoAIProvider(), 'demo').runJob(job!);
    const columns = await store.pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'shopping_sessions'");
    expect(columns.rows.map(row => row.column_name)).not.toContain('data');
    const history = await store.history(created.id);
    expect(history.length).toBeGreaterThan(3);
    expect(history[0].session).toEqual(created);
    expect(history.at(-1)?.session.rounds[0].products).toHaveLength(6);
    const identity = (await store.pool.query('SELECT version, stage FROM shopping_sessions WHERE id = $1', [created.id])).rows[0];
    expect(identity).toEqual({ version: 0, stage: 'ask' });
    expect((await store.pool.query('SELECT count(*) FROM session_messages WHERE session_id = $1', [created.id])).rows[0].count).toBe('0');
    await expect(store.pool.query('UPDATE session_versions SET state = state WHERE session_id = $1', [created.id])).rejects.toMatchObject({ code: '55000' });
    await expect(store.pool.query('UPDATE shopping_sessions SET stage = stage WHERE id = $1', [created.id])).rejects.toMatchObject({ code: '55000' });
    const loaded = await store.get(created.id, owner);
    expect(loaded.rounds[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(loaded.askMessages).toHaveLength(2);
    expect(loaded.rounds[0].products[0].offers[0].price.amountCents).toBeGreaterThan(0);
    const discarded = loaded.rounds[0].products[0];
    await service.learn(created.id, owner, { productId: discarded.id, reason: 'Lighter than 1.5 kg' });
    const nextJob = await store.claim(); expect(nextJob).not.toBeNull();
    await service.runJob(nextJob!);
    const learned = await second.get(created.id, owner);
    expect(learned.rounds).toHaveLength(2);
    expect(learned.feedback[0].reason).toContain('1.5 kg');
    expect(learned.rounds[1].context.feedback[0].reason).toContain('1.5 kg');
    expect(learned.rounds[1].context.previousProducts).toHaveLength(6);
    expect(learned.rounds[1].context.discardedProducts.map(p => p.id)).toContain(discarded.id);
    expect(learned.rounds[1].products.map(p => p.id)).not.toContain(discarded.id);
  });
  it('retains closed sessions and usage until explicit maintenance, with no expiry cleanup', async () => {
    const service = new ShoppingService(store, new DemoAIProvider(), 'demo');
    const created = await service.create(owner); ids.push(created.id);
    await store.archive(created.id, owner);
    await expect(store.get(created.id, owner)).rejects.toMatchObject({ status: 404 });
    expect(await store.latest(owner)).not.toMatchObject({ id: created.id });
    expect((await second.history(created.id)).at(-1)?.archived).toBe(true);
    expect((await second.get(created.id)).id).toBe(created.id);
    await second.migrate();
    expect((await second.history(created.id)).at(-1)?.archived).toBe(true);
    await store.purge(created.id);
    expect((await store.pool.query('SELECT id FROM shopping_sessions WHERE id = $1', [created.id])).rows).toEqual([]);
    expect((await store.pool.query('SELECT version FROM session_versions WHERE session_id = $1', [created.id])).rows).toEqual([]);
  });
  it('rejects competing appends based on the same version across connections', async () => {
    const created = await new ShoppingService(store, new DemoAIProvider(), 'demo').create(owner); ids.push(created.id);
    const results = await Promise.allSettled([
      store.append(created.id, owner, s => { s.config.budgetMax = 100; }, created.version),
      second.append(created.id, owner, s => { s.config.budgetMax = 200; }, created.version),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { status: 409, code: 'SESSION_CONFLICT' } });
    expect(await store.history(created.id)).toHaveLength(2);
  });
  it('recomputes pure concurrent appends without losing changes and archives idempotently', async () => {
    const created = await new ShoppingService(store, new DemoAIProvider(), 'demo').create(owner); ids.push(created.id);
    const increment = (s: typeof created): undefined => { s.config.budgetMax = (s.config.budgetMax ?? 0) + 1; };
    await Promise.all([store.append(created.id, owner, increment), second.append(created.id, owner, increment)]);
    expect((await second.get(created.id)).config.budgetMax).toBe(2);
    expect(await second.history(created.id)).toHaveLength(3);
    await Promise.all([store.archive(created.id, owner), second.archive(created.id, owner)]);
    expect(await second.history(created.id)).toHaveLength(4);
    await expect(store.append(created.id, null, increment)).rejects.toMatchObject({ status: 404 });
  });
  it('releases every pool connection before AI and rejects late results after a concurrent purge', async () => {
    const ai = new DemoAIProvider(); const service = new ShoppingService(store, ai, 'demo');
    const created = await service.create(owner); ids.push(created.id);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(r => { entered = r; });
    const gate = new Promise<void>(r => { release = r; });
    const original = ai.converse.bind(ai);
    vi.spyOn(ai, 'converse').mockImplementation(async (...args) => { entered(); await gate; return original(...args); });
    const pending = service.message(created.id, owner, 'ask', 'Laptop for coding in Italy');
    const rejected = expect(pending).rejects.toMatchObject({ status: 404 });
    await started;
    expect(store.pool.idleCount).toBe(store.pool.totalCount);
    await second.purge(created.id);
    release(); await rejected;
    expect((await second.pool.query('SELECT version FROM session_versions WHERE session_id = $1', [created.id])).rows).toEqual([]);
  });
  it('migrates normalized sessions once, including legacy expired state, without inventing history', async () => {
    const id = randomUUID(); ids.push(id);
    await store.pool.query(`INSERT INTO shopping_sessions (id, owner_hash, version, mode, ask_session_id, configure_session_id, expires_at)
      VALUES ($1, $2, 7, 'demo', $3, $4, now() - interval '1 day')`, [id, owner, randomUUID(), randomUUID()]);
    await store.pool.query("INSERT INTO session_messages (session_id, phase, position, role, content) VALUES ($1, 'ask', 0, 'user', 'Historical message')", [id]);
    await store.migrate();
    const history = await second.history(id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ version: 7, parentVersion: null, kind: 'migrated', archived: false });
    expect(history[0].session.askMessages[0].content).toBe('Historical message');
    await store.append(id, owner, s => { s.config.budgetMax = 500; });
    await second.migrate();
    expect(await second.history(id)).toHaveLength(2);
    expect((await store.pool.query('SELECT content FROM session_messages WHERE session_id = $1', [id])).rows[0].content).toBe('Historical message');
  });
});
