import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { logger } from './logger';

export interface UsageEvent {
  id: string; sessionId: string; roundId: string | null; phase: string; operation: string;
  provider: string; model: string; status: string; inputTokens: number | null; outputTokens: number | null;
  cachedTokens: number | null; reasoningTokens: number | null; durationMs: number;
  estimatedCostUsd: number | null; createdAt: string;
}
interface Scope { sessionId: string; roundId: string | null; phase: string; events: UsageEvent[] }
const context = new AsyncLocalStorage<Scope>();
export interface Rates { input: number; output: number }
export type PriceTable = Record<string, Rates>;
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

// Reasoning is included in output, cached input in input: neither is added twice.
export function recordUsage(provider: string, model: string, operation: string, status: string, durationMs: number, raw?: unknown, prices: PriceTable = {}) {
  const scope = context.getStore();
  if (!scope) return;
  const usage = (raw ?? {}) as Record<string, any>;
  const inputTokens = count(usage.input_tokens ?? usage.prompt_tokens);
  const outputTokens = count(usage.output_tokens ?? usage.completion_tokens);
  const rates = prices[model] ?? prices['*'];
  scope.events.push({
    id: randomUUID(), sessionId: scope.sessionId, roundId: scope.roundId, phase: scope.phase,
    provider, model, operation, status, durationMs, inputTokens, outputTokens,
    cachedTokens: count(usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens),
    reasoningTokens: count(usage.output_tokens_details?.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens),
    estimatedCostUsd: rates && inputTokens !== null && outputTokens !== null ? (inputTokens * rates.input + outputTokens * rates.output) / 1_000_000 : null,
    createdAt: new Date().toISOString(),
  });
}

export class UsageStore {
  private memory: UsageEvent[] = [];
  constructor(private pool?: Pool) {}
  async capture<T>(sessionId: string, phase: string, roundId: string | null, action: () => Promise<T>): Promise<T> {
    const scope: Scope = { sessionId, phase, roundId, events: [] };
    try { return await context.run(scope, action); }
    finally {
      // Flush after the shopping transaction commits/rolls back, avoiding FK lock deadlocks.
      for (const event of scope.events) {
        try { await this.save(event); }
        catch { logger.error('usage.persistence.failed', { sessionId, eventId: event.id }); }
      }
    }
  }
  private async save(e: UsageEvent) {
    if (!this.pool) { this.memory.push(e); return; }
    // Parent locking serializes with deletion. Deleted sessions never regain usage rows.
    await this.pool.query(`INSERT INTO ai_usage
      (id, session_id, round_id, phase, operation, provider, model, status, input_tokens, output_tokens, cached_tokens, reasoning_tokens, duration_ms, estimated_cost_usd, created_at)
      SELECT $1, id, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15 FROM shopping_sessions WHERE id = $2 FOR KEY SHARE`,
    [e.id, e.sessionId, e.roundId, e.phase, e.operation, e.provider, e.model, e.status, e.inputTokens, e.outputTokens, e.cachedTokens, e.reasoningTokens, e.durationMs, e.estimatedCostUsd, e.createdAt]);
  }
  async get(sessionId: string): Promise<UsageEvent[]> {
    if (!this.pool) return this.memory.filter(e => e.sessionId === sessionId);
    const { rows } = await this.pool.query(`SELECT id, session_id AS "sessionId", round_id AS "roundId", phase, operation, provider, model, status,
      input_tokens AS "inputTokens", output_tokens AS "outputTokens", cached_tokens AS "cachedTokens", reasoning_tokens AS "reasoningTokens",
      duration_ms AS "durationMs", estimated_cost_usd AS "estimatedCostUsd", created_at AS "createdAt"
      FROM ai_usage WHERE session_id = $1 ORDER BY created_at, id`, [sessionId]);
    return rows;
  }
  // PostgreSQL usage is removed by the session FK cascade during admin maintenance.
  purgeMemory(sessionId: string) { this.memory = this.memory.filter(e => e.sessionId !== sessionId); }
}
