import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresStore } from '../src/store';
import { DemoAIProvider } from '../src/ai/demo';
import { ShoppingService } from '../src/shopping-service';

describe.skipIf(!process.env.TEST_DATABASE_URL)('PostgreSQL persistence, ownership and durable jobs', () => {
  const url = process.env.TEST_DATABASE_URL!;
  let store: PostgresStore, second: PostgresStore;
  const owner = `test-${randomUUID()}`; const ids: string[] = [];
  beforeAll(async () => { store = new PostgresStore(url); second = new PostgresStore(url); await Promise.all([store.migrate(), second.migrate()]); });
  afterAll(async () => { for (const id of ids) await store.delete(id, owner); await Promise.all([store.close(), second.close()]); });
  it('persists through a new repository connection and isolates owner queries', async () => {
    const service = new ShoppingService(store, new DemoAIProvider(), 'demo');
    const created = await service.create(owner); ids.push(created.id);
    await service.message(created.id, owner, 'ask', 'Laptop for coding in Italy, budget €700');
    expect((await second.get(created.id, owner)).ready).toBe(true);
    await expect(second.get(created.id, 'other-owner')).rejects.toMatchObject({ status: 404 });
    expect((await second.latest(owner))?.id).toBe(created.id);
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
    await store.delete(created.id, owner);
    expect((await store.pool.query('SELECT id FROM discovery_jobs WHERE session_id = $1', [created.id])).rows).toEqual([]);
  });
  it('enforces seven-day retention without deleting other test data', async () => {
    const service = new ShoppingService(store, new DemoAIProvider(), 'demo');
    const created = await service.create(owner); ids.push(created.id);
    await store.pool.query("UPDATE shopping_sessions SET expires_at = now() - interval '1 second' WHERE id = $1", [created.id]);
    await expect(store.get(created.id, owner)).rejects.toMatchObject({ status: 404 });
    await store.cleanup();
    expect((await store.pool.query('SELECT id FROM shopping_sessions WHERE id = $1', [created.id])).rows).toEqual([]);
  });
});
