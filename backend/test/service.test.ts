import { describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../src/store';
import { ShoppingService } from '../src/shopping-service';
import { DemoAIProvider } from '../src/ai/demo';
import { AppError } from '../src/errors';

async function setup() {
  const store = new MemoryStore(); const ai = new DemoAIProvider(); const service = new ShoppingService(store, ai, 'demo');
  const created = await service.create('alice');
  const session = await service.message(created.id, 'alice', 'ask', 'Laptop for coding in Italy, budget €700');
  return { store, ai, service, session };
}
async function run(service: ShoppingService) { const job = await service.store.claim(); expect(job).not.toBeNull(); await service.runJob(job!); }
describe('real backend shopping orchestration', () => {
  it('preserves isolated Ask and Configure conversations without an arbitrary turn count', async () => {
    const { service, session } = await setup();
    expect(session.ready).toBe(true);
    const updated = await service.message(session.id, 'alice', 'configure', 'Keep this budget');
    expect(updated.askSessionId).not.toBe(updated.configureSessionId);
    expect(updated.askMessages).toHaveLength(2); expect(updated.configureMessages).toHaveLength(2);
  });
  it('starts every Learn/Undo as a fresh discovery with complete accumulated context', async () => {
    const { service, store, session, ai } = await setup();
    const spy = vi.spyOn(ai, 'discover');
    await service.discover(session.id, 'alice'); await run(service);
    let current = await store.get(session.id);
    const initial = structuredClone(current.config);
    const rejected = current.rounds[0].products[0];
    await service.learn(session.id, 'alice', { productId: rejected.id, reason: 'Lighter than 1.5 kg please' }); await run(service);
    current = await store.get(session.id);
    expect(current.rounds[1].id).not.toBe(current.rounds[0].id);
    const nextContext = spy.mock.calls[1][0];
    expect(nextContext.discoverySessionId).toBe(current.rounds[1].id);
    expect(nextContext.initialConfig).toEqual(initial);
    expect(nextContext.initialRequest).toContain('Laptop for coding');
    expect(nextContext.previousProducts).toHaveLength(6);
    expect(nextContext.discardedProducts.map(p => p.id)).toContain(rejected.id);
    expect(nextContext.feedback[0].reason).toContain('1.5 kg');
    expect(current.rounds[1].products.map(p => p.id)).not.toContain(rejected.id);
    expect(current.config.requirements).toEqual(initial.requirements); // learned prefs don't overwrite base
    await service.learn(session.id, 'alice', { productId: null, reason: 'A matte screen too' }); await run(service);
    current = await store.get(session.id);
    expect(current.rounds[2].context.feedback).toHaveLength(2);
    const edit = { ...current.config, budgetMax: 900 };
    await service.configure(session.id, 'alice', edit);
    await service.undo(session.id, 'alice', current.feedback[0].id); await run(service);
    current = await store.get(session.id);
    expect(current.config.budgetMax).toBe(900);
    expect(current.initialConfig).toEqual(initial);
    expect(current.feedback.map(f => f.reason)).toEqual(['A matte screen too']);
    expect(current.rounds.at(-1)?.context.discardedProducts).toEqual([]);
    expect(current.rounds.at(-1)?.products.map(p => p.id)).toContain(rejected.id);
  });
  it('is idempotent for concurrent discovery and rejects edits during a search', async () => {
    const { service, store, session } = await setup();
    await Promise.all([service.discover(session.id, 'alice'), service.discover(session.id, 'alice')]);
    expect((await store.get(session.id)).rounds).toHaveLength(1);
    await expect(service.configure(session.id, 'alice', session.config)).rejects.toMatchObject({ status: 409 });
  });
  it('keeps failed discovery explicit and retryable with no fake offers', async () => {
    const { service, store, session, ai } = await setup();
    vi.spyOn(ai, 'discover').mockRejectedValueOnce(new AppError(502, 'Provider unavailable'));
    await service.discover(session.id, 'alice'); await run(service);
    let current = await store.get(session.id);
    expect(current.rounds[0]).toMatchObject({ status: 'failed', products: [], error: 'Provider unavailable' });
    await service.discover(session.id, 'alice'); await run(service);
    current = await store.get(session.id);
    expect(current.rounds[1].status).toBe('complete');
  });
  it('does not commit a failed conversation or feedback interpretation', async () => {
    const { service, store, session, ai } = await setup();
    const snapshot = await store.get(session.id);
    vi.spyOn(ai, 'converse').mockRejectedValueOnce(new Error('untrusted provider detail'));
    await expect(service.message(session.id, 'alice', 'ask', 'more')).rejects.toThrow();
    expect(await store.get(session.id)).toEqual(snapshot);
    await service.discover(session.id, 'alice'); await run(service);
    vi.spyOn(ai, 'learn').mockRejectedValueOnce(new Error('timeout'));
    await expect(service.learn(session.id, 'alice', { productId: null, reason: 'lighter' })).rejects.toThrow();
    expect((await store.get(session.id)).feedback).toHaveLength(0);
  });
  it('persists and ranks the first product before discovery finishes', async () => {
    const { service, store, session, ai } = await setup();
    const original = ai.discover.bind(ai);
    let published!: () => void, release!: () => void;
    const first = new Promise<void>(resolve => { published = resolve; });
    const remaining = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(ai, 'discover').mockImplementation(async (context, onProgress) => {
      const result = await original(context);
      await onProgress?.({ ...result, products: result.products.slice(0, 1) });
      published(); await remaining;
      return result;
    });
    const queued = await service.discover(session.id, 'alice');
    const pending = run(service);
    await first;
    const partial = await store.get(session.id, 'alice');
    expect(partial.version).toBeGreaterThan(queued.version);
    expect(partial.rounds[0].status).toBe('running');
    expect(partial.rounds[0].startedAt).not.toBeNull();
    expect(partial.rounds[0].durationMs).toBeNull();
    expect(partial.rounds[0].products).toHaveLength(1);
    expect(partial.rounds[0].ranking?.ranked).toHaveLength(2);
    await expect(service.select(session.id, 'alice', partial.rounds[0].products[0].id)).rejects.toMatchObject({ status: 409 });
    release(); await pending;
    const complete = await store.get(session.id, 'alice');
    expect(complete.rounds[0].status).toBe('complete');
    expect(complete.rounds[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(complete.rounds[0].finishedAt).not.toBeNull();
    expect(complete.rounds[0].products).toHaveLength(6);
    expect(complete.rounds[0].products[0].offers).toHaveLength(2);
  });
  it('retains grounded partial products and rankings when a later provider request fails', async () => {
    const { service, store, session, ai } = await setup();
    const original = ai.discover.bind(ai);
    vi.spyOn(ai, 'discover').mockImplementation(async (context, onProgress) => {
      const result = await original(context);
      await onProgress?.({ ...result, products: result.products.slice(0, 1) });
      throw new AppError(502, 'Later research failed');
    });
    await service.discover(session.id, 'alice'); await run(service);
    const round = (await store.get(session.id)).rounds[0];
    expect(round).toMatchObject({ status: 'failed', error: 'Later research failed' });
    expect(round.products).toHaveLength(1);
    expect(round.ranking?.ranked).toHaveLength(2);
  });
  it('rejects stale selections and enforces ownership', async () => {
    const { service, store, session } = await setup();
    await expect(store.get(session.id, 'mallory')).rejects.toMatchObject({ status: 404 });
    await expect(service.discover(session.id, 'mallory')).rejects.toMatchObject({ status: 404 });
    await service.discover(session.id, 'alice'); await run(service);
    const product = (await store.get(session.id)).rounds[0].products[0];
    await service.configure(session.id, 'alice', { ...session.config, budgetMax: 100 });
    await expect(service.select(session.id, 'alice', product.id)).rejects.toMatchObject({ status: 409 });
    await store.archive(session.id, 'mallory'); expect(await store.get(session.id, 'alice')).toBeDefined();
    await store.archive(session.id, 'alice'); await expect(store.get(session.id, 'alice')).rejects.toMatchObject({ status: 404 });
    expect(await store.get(session.id)).toBeDefined(); // Retained for administrators.
  });
  it('persists navigation and never mixes demo sessions into live operations', async () => {
    const { service, store, session, ai } = await setup();
    await service.navigate(session.id, 'alice', 'configure');
    expect((await store.get(session.id)).stage).toBe('configure');
    await expect(service.navigate(session.id, 'alice', 'buy')).rejects.toMatchObject({ status: 409 });
    const otherMode = new ShoppingService(store, ai, 'live');
    await expect(otherMode.discover(session.id, 'alice')).rejects.toMatchObject({ status: 409 });
  });
});
