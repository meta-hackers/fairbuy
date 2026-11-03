import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { ClientEventSchema, DiagnosticInputSchema, type DiagnosticInput, type DiagnosticScope } from '@fairbuy/core';
import { DiagnosticStore, diagnosticTraceId, recordDiagnostic, traceProductImage } from '../src/diagnostics';
import { logger } from '../src/logger';

const scope = (): DiagnosticScope => ({ traceId: randomUUID(), source: 'server', sessionId: null, roundId: null, productId: null });
const browser = (): DiagnosticInput => ({ ...scope(), source: 'browser', event: 'client.runtime_error', level: 'error', details: { errorType: 'TypeError' } });

describe('durable diagnostic store', () => {
  it('keeps concurrent traces isolated and records only failing paths when requested', async () => {
    const store = new DiagnosticStore();
    const a = scope(), b = scope();
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const first = store.capture(a, async () => {
      recordDiagnostic('image.request.started', 'info');
      await wait;
      expect(diagnosticTraceId()).toBe(a.traceId);
      recordDiagnostic('image.fetch.unavailable', 'warn', { domain: 'seller.org', status: 403 });
    }, true);
    await store.capture(b, async () => {
      expect(diagnosticTraceId()).toBe(b.traceId);
      recordDiagnostic('image.request.completed', 'info', { available: true });
    }, true);
    release(); await first;
    expect((await store.list({ page: 1, traceId: b.traceId })).total).toBe(0);
    const trace = await store.list({ page: 1, traceId: a.traceId });
    expect(trace.events.map(e => e.event)).toEqual(['image.request.started', 'image.fetch.unavailable']);
    expect(trace.events.every(e => e.traceId === a.traceId)).toBe(true);
  });

  it('gives concurrent discovery images their own product trace and preserves scope on failure', async () => {
    const store = new DiagnosticStore(); const parent = scope();
    const log = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    try {
      await store.capture(parent, async () => {
        await traceProductImage('product-a', async () => null);
        await expect(traceProductImage('product-b', async () => { throw new Error('private text'); })).rejects.toThrow('private text');
      });
      const events = (await store.list({ page: 1 })).events;
      expect(new Set(events.map(e => e.traceId)).size).toBe(2);
      expect(events.every(e => e.traceId !== parent.traceId)).toBe(true);
      expect(events.map(e => e.productId).sort()).toEqual(['product-a', 'product-b']);
      expect(JSON.stringify(events)).not.toContain('private text');
    } finally { log.mockRestore(); }
  });

  it('bounds each trace but always retains its final error', async () => {
    const store = new DiagnosticStore();
    await store.capture(scope(), async () => {
      recordDiagnostic('image.request.started', 'info');
      for (let i = 0; i < 80; i++) recordDiagnostic('image.page.completed', 'info', { status: 200 });
      recordDiagnostic('image.request.completed', 'warn', { available: false });
    }, true);
    const events = (await store.list({ page: 1 })).events;
    expect(events).toHaveLength(50);
    expect(events[0].event).toBe('image.request.completed');
    expect(events.at(-1)?.event).toBe('image.request.started');
  });

  it('deduplicates browser reports, filters and paginates without exposing arbitrary payloads', async () => {
    const store = new DiagnosticStore(); const event = browser();
    store.record(event); store.record(event);
    expect((await store.list({ page: 1, traceId: event.traceId })).total).toBe(1);
    for (let i = 0; i < 60; i++) store.record(browser());
    const first = await store.list({ page: 1, source: 'browser', level: 'error' });
    expect(first.total).toBe(61); expect(first.events).toHaveLength(50);
    expect((await store.list({ page: 2 })).events).toHaveLength(11);
    expect((await store.list({ page: 1, source: 'server' })).total).toBe(0);
    expect(DiagnosticInputSchema.safeParse({ ...event, details: { message: 'secret' } }).success).toBe(false);
    expect(ClientEventSchema.safeParse({ kind: 'runtime_error', errorType: 'TypeError', traceId: 'not-a-uuid' }).success).toBe(false);
    expect(ClientEventSchema.safeParse({ kind: 'runtime_error', errorType: 'TypeError', asset: '/assets/main.js?token=secret' }).success).toBe(false);
  });

  it('keeps older events visible and cannot restore a purged session from the queue', async () => {
    const store = new DiagnosticStore(); const event = browser();
    store.record(event); await store.flush();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 86400000);
    try {
      expect((await store.list({ page: 1, traceId: event.traceId })).total).toBe(1);
    } finally { clock.mockRestore(); }
    expect((await store.list({ page: 1 })).total).toBe(1);
    const sessionId = randomUUID();
    store.record({ ...browser(), sessionId });
    store.purgeSession(sessionId);
    store.record({ ...browser(), sessionId });
    expect((await store.list({ page: 1, sessionId })).total).toBe(0);
  });

  it('does not wait for database persistence or propagate its failures to requests', async () => {
    let fail!: (error: Error) => void;
    const waiting = new Promise((_resolve, reject) => { fail = reject; });
    const query = vi.fn().mockReturnValue(waiting);
    const store = new DiagnosticStore({ query } as unknown as Pool);
    const log = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    try {
      const result = await store.capture(scope(), async () => {
        recordDiagnostic('image.request.completed', 'warn', { available: false });
        return 'response already available';
      });
      expect(result).toBe('response already available');
      expect(query).toHaveBeenCalled();
      expect(query.mock.calls[0][0].query_timeout).toBe(2000);
      fail(new Error('private database credentials'));
      await expect(store.flush()).resolves.toBeUndefined();
      expect(log).toHaveBeenCalledWith('diagnostics.persistence.failed', { events: 1 });
      expect(JSON.stringify(log.mock.calls)).not.toContain('credentials');
    } finally { log.mockRestore(); }
  });

  it('bounds the write queue during a database outage', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const query = vi.fn().mockReturnValueOnce(pending).mockResolvedValue({ rowCount: 0 });
    const store = new DiagnosticStore({ query } as unknown as Pool);
    const log = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      for (let i = 0; i < 1100; i++) store.record(browser());
      release(); await store.flush();
      expect(log).toHaveBeenCalledWith('diagnostics.queue.full');
      const saved = query.mock.calls.reduce((sum, call) => sum + JSON.parse(call[0].values[0]).length, 0);
      expect(saved).toBe(1000);
    } finally { log.mockRestore(); }
  });
});
