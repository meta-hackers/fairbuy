import { describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../src/store';
import { ShoppingService } from '../src/shopping-service';
import { DemoAIProvider } from '../src/ai/demo';
import { recordUsage } from '../src/usage';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
async function setup() {
  const store = new MemoryStore(); const ai = new DemoAIProvider();
  const service = new ShoppingService(store, ai, 'demo');
  const session = await service.create('owner');
  return { store, ai, service, session };
}
async function discover(service: ShoppingService, id: string) {
  await service.discover(id, 'owner');
  await service.runJob((await service.store.claim())!);
}

describe('append-only sessions', () => {
  it('keeps earlier versions immutable, returns independent copies and skips no-op revisions', async () => {
    const { store, service, session } = await setup();
    await service.message(session.id, 'owner', 'ask', 'Laptop for coding in Italy');
    const history = await store.history(session.id);
    expect(history.map(r => [r.version, r.parentVersion])).toEqual([[0, null], [1, 0]]);
    expect(history[0].session).toEqual(session);
    expect(history[1].session.askMessages).toHaveLength(2);
    history[0].session.config.budgetMax = 999;
    expect((await store.history(session.id))[0].session).toEqual(session);
    await store.append(session.id, 'owner', () => {});
    expect(await store.history(session.id)).toHaveLength(2);
    await expect(store.append(session.id, 'owner', s => { s.id = 'different'; })).rejects.toThrow('immutable');
  });

  it('does not hold a session lock during AI calls and never replays stale generation', async () => {
    const { store, ai, service, session } = await setup();
    const entered = deferred(); const release = deferred();
    const original = ai.converse.bind(ai);
    const call = vi.spyOn(ai, 'converse').mockImplementation(async (...args) => {
      entered.resolve(); await release.promise;
      recordUsage('meta', 'model', 'generation', 'completed', 1);
      return original(...args);
    });
    const pending = service.message(session.id, 'owner', 'ask', 'Laptop for coding in Italy');
    const rejected = expect(pending).rejects.toMatchObject({ status: 409, code: 'SESSION_CONFLICT' });
    await entered.promise;
    await service.locate(session.id, 'owner', { country: 'Switzerland', city: null, currency: 'CHF' });
    release.resolve(); await rejected;
    const latest = await store.get(session.id, 'owner');
    expect(latest.config.currency).toBe('CHF');
    expect(latest.askMessages).toEqual([]);
    expect(call).toHaveBeenCalledOnce();
    expect(await service.usage.get(session.id)).toHaveLength(1);
    expect(await store.history(session.id)).toHaveLength(2);
  });

  it('does not resurrect a session closed or purged while generation is in flight', async () => {
    for (const purge of [false, true]) {
      const { store, ai, service, session } = await setup();
      const entered = deferred(); const release = deferred();
      const original = ai.converse.bind(ai);
      vi.spyOn(ai, 'converse').mockImplementation(async (...args) => {
        entered.resolve(); await release.promise; return original(...args);
      });
      const pending = service.message(session.id, 'owner', 'ask', 'Laptop for coding in Italy');
      const rejected = expect(pending).rejects.toMatchObject({ status: 404 });
      await entered.promise;
      if (purge) await store.purge(session.id);
      else await store.archive(session.id, 'owner');
      release.resolve(); await rejected;
      expect(await store.latest('owner')).toBeNull();
      if (purge) await expect(store.history(session.id)).rejects.toMatchObject({ status: 404 });
      else {
        const history = await store.history(session.id);
        expect(history).toHaveLength(2);
        expect(history[1]).toMatchObject({ archived: true, kind: 'archived' });
        expect(history[1].session.askMessages).toEqual([]);
      }
    }
  });

  it('records Undo as a revocation and retains feedback, contexts and round progress in older versions', async () => {
    const { store, service, session } = await setup();
    await service.message(session.id, 'owner', 'ask', 'Laptop for coding in Italy');
    await discover(service, session.id);
    await service.learn(session.id, 'owner', { productId: null, reason: 'A matte screen' });
    await service.runJob((await store.claim())!);
    const before = await store.get(session.id, 'owner');
    const feedbackId = before.feedback[0].id;
    await service.undo(session.id, 'owner', feedbackId);
    const history = await store.history(session.id);
    expect(history.at(-1)?.revokedFeedbackIds).toEqual([feedbackId]);
    expect(history.at(-1)?.session.feedback).toEqual([]);
    expect(history.at(-2)?.session).toEqual(before);
    expect(history.some(r => r.session.rounds[0]?.status === 'running')).toBe(true);
    expect(history.at(-1)?.session.rounds[1].context.feedback[0].id).toBe(feedbackId);
  });

  it('rejects stale Learn results without queuing another round or replaying AI', async () => {
    const { store, ai, service, session } = await setup();
    await service.message(session.id, 'owner', 'ask', 'Laptop for coding in Italy');
    await discover(service, session.id);
    const entered = deferred(); const release = deferred();
    const original = ai.learn.bind(ai);
    const call = vi.spyOn(ai, 'learn').mockImplementation(async (...args) => {
      entered.resolve(); await release.promise; return original(...args);
    });
    const pending = service.learn(session.id, 'owner', { productId: null, reason: 'A matte screen' });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'SESSION_CONFLICT' });
    await entered.promise;
    const current = await store.get(session.id, 'owner');
    await service.configure(session.id, 'owner', { ...current.config, budgetMax: 900 });
    release.resolve(); await rejected;
    const latest = await store.get(session.id);
    expect(latest.feedback).toEqual([]);
    expect(latest.rounds).toHaveLength(1);
    expect(await store.claim()).toBeNull();
    expect(call).toHaveBeenCalledOnce();
  });

  it('keeps closed sessions out of worker claims without deleting queued jobs or history', async () => {
    const { store, service, session } = await setup();
    await service.message(session.id, 'owner', 'ask', 'Laptop for coding in Italy');
    await service.discover(session.id, 'owner');
    await store.archive(session.id, 'owner');
    await store.archive(session.id, 'owner'); // Idempotent.
    expect(await store.claim()).toBeNull();
    expect((await store.history(session.id)).at(-1)?.kind).toBe('archived');
    expect((await store.get(session.id)).rounds[0].status).toBe('queued');
    await expect(store.append(session.id, null, s => { s.stage = 'buy'; })).rejects.toMatchObject({ status: 404 });
    expect((await store.listSessions({ search: session.id, stage: '', mode: '', page: 1 })).sessions[0].archived).toBe(true);
  });
});
