import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  DiagnosticInputSchema, DiagnosticScopeSchema,
  type DiagnosticDetails, type DiagnosticEvent, type DiagnosticInput, type DiagnosticQuery, type DiagnosticScope,
} from '@fairbuy/core';
import { logger } from './logger';

const PAGE_SIZE = 50;
interface Scope extends DiagnosticScope { store: DiagnosticStore; events: DiagnosticEvent[] }
const context = new AsyncLocalStorage<Scope>();

/** Explicit allowlist, not a hook that persists arbitrary application logs. */
export function recordDiagnostic(event: DiagnosticInput['event'], level: DiagnosticInput['level'], details: DiagnosticDetails = {}) {
  const scope = context.getStore();
  if (!scope) return;
  const parsed = DiagnosticInputSchema.safeParse({
    traceId: scope.traceId, source: scope.source, sessionId: scope.sessionId, roundId: scope.roundId, productId: scope.productId,
    event, level, details,
  });
  if (!parsed.success) return;
  // Preserve the start and most recent steps, especially the final failure.
  if (scope.events.length >= 50) scope.events.splice(1, 1);
  scope.events.push({ ...parsed.data, id: randomUUID(), createdAt: new Date().toISOString() });
  const { event: kind, level: severity, ...fields } = parsed.data;
  logger[severity](kind, fields);
}
export function diagnosticTraceId() { return context.getStore()?.traceId; }

/** Discovery runs image enrichment concurrently; each product gets its own trace. */
export async function traceProductImage(productId: string, action: () => Promise<string | null>) {
  const scope = context.getStore();
  if (!scope) return action();
  return scope.store.capture({ traceId: randomUUID(), source: 'server', sessionId: scope.sessionId, roundId: scope.roundId, productId }, async () => {
    const started = Date.now();
    try {
      const image = await action();
      recordDiagnostic('image.product.resolved', image ? 'info' : 'warn', { operation: 'discovery', available: !!image, durationMs: Date.now() - started });
      return image;
    } catch (error) {
      recordDiagnostic('image.product.resolved', 'error', { operation: 'discovery', available: false, reason: 'unexpected' });
      throw error;
    }
  }, true);
}

export class DiagnosticStore {
  private memory: DiagnosticEvent[] = [];
  private queue: DiagnosticEvent[] = [];
  private running?: Promise<void>;
  private purged = new Set<string>();
  constructor(private pool?: Pool) {}
  get persistent() { return !!this.pool; }

  async capture<T>(input: DiagnosticScope, action: () => Promise<T>, errorsOnly = false): Promise<T> {
    const parsed = DiagnosticScopeSchema.safeParse(input);
    if (!parsed.success) { logger.warn('diagnostics.scope.invalid'); return action(); }
    const scope: Scope = { ...parsed.data, store: this, events: [] };
    try { return await context.run(scope, action); }
    finally { if (!errorsOnly || scope.events.some(e => e.level !== 'info')) this.enqueue(scope.events); }
  }
  record(input: DiagnosticInput) {
    const parsed = DiagnosticInputSchema.safeParse(input);
    if (!parsed.success) return;
    this.enqueue([{ ...parsed.data, id: randomUUID(), createdAt: new Date().toISOString() }]);
  }
  private enqueue(events: DiagnosticEvent[]) {
    const accepted = events.filter(e => !e.sessionId || !this.purged.has(e.sessionId));
    const room = Math.max(0, 1000 - this.queue.length);
    this.queue.push(...accepted.slice(0, room));
    if (accepted.length > room) logger.warn('diagnostics.queue.full');
    // Never await database writes on the shopping/image request path. A single
    // bounded writer avoids exhausting the small shared PostgreSQL pool.
    if (!this.running && this.queue.length) {
      this.running = Promise.resolve().then(() => this.drain()).finally(() => {
        this.running = undefined;
        if (this.queue.length) this.enqueue([]);
      });
    }
  }
  private async drain() {
    while (this.queue.length) {
      const events = this.queue.splice(0, 100).filter(e => !e.sessionId || !this.purged.has(e.sessionId));
      if (!events.length) continue;
      if (!this.pool) {
        const keys = new Set(this.memory.filter(e => e.source === 'browser').map(e => `${e.traceId}:${e.event}`));
        for (const event of events) {
          const key = `${event.traceId}:${event.event}`;
          if (event.source === 'browser' && keys.has(key)) continue;
          if (event.source === 'browser') keys.add(key);
          this.memory.push(event);
        }
        this.memory = this.memory.slice(-10000);
        continue;
      }
      try {
        const query = { text: `INSERT INTO diagnostic_events
          (id, trace_id, session_id, round_id, product_id, source, level, event, details, created_at)
          SELECT x.id, x."traceId", x."sessionId", x."roundId", x."productId", x.source, x.level, x.event, x.details, x."createdAt"
          FROM jsonb_to_recordset($1::jsonb) AS x(id uuid, "traceId" uuid, "sessionId" uuid, "roundId" uuid, "productId" text,
            source text, level text, event text, details jsonb, "createdAt" timestamptz, ordinal integer)
          LEFT JOIN shopping_sessions s ON s.id = x."sessionId"
          WHERE x."sessionId" IS NULL OR s.id IS NOT NULL
          ORDER BY x.ordinal
          ON CONFLICT DO NOTHING`, values: [JSON.stringify(events.map((event, ordinal) => ({ ...event, ordinal })))], query_timeout: 2000 };
        await this.pool.query(query);
      } catch { logger.error('diagnostics.persistence.failed', { events: events.length }); }
    }
  }
  async flush() { while (this.running) await this.running; }

  async list(query: DiagnosticQuery) {
    const offset = (query.page - 1) * PAGE_SIZE;
    if (!this.pool) {
      await this.flush();
      const events = this.memory.filter(e => (!query.traceId || e.traceId === query.traceId) && (!query.sessionId || e.sessionId === query.sessionId)
        && (!query.source || e.source === query.source) && (!query.level || e.level === query.level))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      // A trace reads chronologically; the global feed shows newest first.
      if (!query.traceId) events.reverse();
      return { events: events.slice(offset, offset + PAGE_SIZE), total: events.length, page: query.page, pageSize: PAGE_SIZE };
    }
    const where = `FROM diagnostic_events WHERE ($1::uuid IS NULL OR trace_id = $1) AND ($2::uuid IS NULL OR session_id = $2)
      AND ($3::text IS NULL OR source = $3) AND ($4::text IS NULL OR level = $4)`;
    const values = [query.traceId ?? null, query.sessionId ?? null, query.source ?? null, query.level ?? null];
    const count = await this.pool.query(`SELECT count(*) ${where}`, values);
    const order = query.traceId ? 'ASC' : 'DESC';
    const result = await this.pool.query(`SELECT id, trace_id AS "traceId", session_id AS "sessionId", round_id AS "roundId",
      product_id AS "productId", source, level, event, details, created_at AS "createdAt" ${where}
      ORDER BY created_at ${order}, sequence ${order} LIMIT 50 OFFSET $5`, [...values, offset]);
    return { events: result.rows as DiagnosticEvent[], total: Number(count.rows[0].count), page: query.page, pageSize: PAGE_SIZE };
  }
  purgeSession(sessionId: string) {
    this.purged.add(sessionId);
    if (this.purged.size > 10000) this.purged.delete(this.purged.values().next().value!);
    this.queue = this.queue.filter(e => e.sessionId !== sessionId);
    this.memory = this.memory.filter(e => e.sessionId !== sessionId);
  }
}
