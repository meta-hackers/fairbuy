import { Pool, type PoolClient } from 'pg';
import { readFile } from 'node:fs/promises';
import type { ShoppingSession } from '@fairbuy/core';
import { AppError } from './errors';

export interface Job { id: string; sessionId: string; attempts: number }
export interface Store {
  create(owner: string, session: ShoppingSession): Promise<void>;
  latest(owner: string): Promise<ShoppingSession | null>;
  get(id: string, owner?: string): Promise<ShoppingSession>;
  mutate(id: string, owner: string | null, action: (session: ShoppingSession) => Promise<void> | void): Promise<ShoppingSession>;
  delete(id: string, owner: string): Promise<void>;
  claim(): Promise<Job | null>;
  finish(job: Job): Promise<void>;
  cleanup(): Promise<void>;
  health(): Promise<void>;
  close(): Promise<void>;
}
const notFound = () => new AppError(404, 'This search was not found or has expired.', 'NOT_FOUND');

export class PostgresStore implements Store {
  readonly pool: Pool;
  constructor(url: string) { this.pool = new Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 5000 }); }
  async migrate() {
    // Idempotent DDL, serialized across overlapping Render deployments.
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(731692401)');
      await client.query(await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8'));
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async create(owner: string, session: ShoppingSession) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [owner]);
      const count = await client.query('SELECT count(*) FROM shopping_sessions WHERE owner_hash = $1 AND expires_at > now()', [owner]);
      if (Number(count.rows[0].count) >= 15) throw new AppError(429, 'Search limit reached. Delete an older search or return after it expires.');
      await client.query('INSERT INTO shopping_sessions(id, owner_hash, data) VALUES ($1, $2, $3)', [session.id, owner, JSON.stringify(session)]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async latest(owner: string) {
    const result = await this.pool.query('SELECT data FROM shopping_sessions WHERE owner_hash = $1 AND expires_at > now() ORDER BY created_at DESC LIMIT 1', [owner]);
    return result.rows[0]?.data ?? null;
  }
  async get(id: string, owner?: string): Promise<ShoppingSession> {
    const result = await this.pool.query('SELECT data FROM shopping_sessions WHERE id = $1 AND ($2::text IS NULL OR owner_hash = $2) AND expires_at > now()', [id, owner ?? null]);
    if (!result.rows.length) throw notFound();
    return result.rows[0].data;
  }
  async mutate(id: string, owner: string | null, action: (session: ShoppingSession) => Promise<void> | void) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query('SELECT data FROM shopping_sessions WHERE id = $1 AND ($2::text IS NULL OR owner_hash = $2) AND expires_at > now() FOR UPDATE', [id, owner]);
      if (!result.rows.length) throw notFound();
      const session: ShoppingSession = result.rows[0].data;
      await action(session);
      session.version++; session.updatedAt = new Date().toISOString();
      await client.query('UPDATE shopping_sessions SET data = $2 WHERE id = $1', [id, JSON.stringify(session)]);
      await this.enqueue(client, session);
      await client.query('COMMIT');
      return session;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  private async enqueue(client: PoolClient, session: ShoppingSession) {
    for (const round of session.rounds.filter(r => r.status === 'queued')) {
      await client.query('INSERT INTO discovery_jobs(id, session_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [round.id, session.id]);
    }
  }
  async delete(id: string, owner: string) { await this.pool.query('DELETE FROM shopping_sessions WHERE id = $1 AND owner_hash = $2', [id, owner]); }
  async claim(): Promise<Job | null> {
    const result = await this.pool.query(`
      UPDATE discovery_jobs SET state = 'running', attempts = attempts + 1, lease_until = now() + interval '5 minutes'
      WHERE id = (SELECT id FROM discovery_jobs WHERE state = 'queued' OR (state = 'running' AND lease_until < now())
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id, session_id, attempts`);
    const row = result.rows[0];
    return row ? { id: row.id, sessionId: row.session_id, attempts: row.attempts } : null;
  }
  async finish(job: Job) { await this.pool.query("UPDATE discovery_jobs SET state = 'done', lease_until = NULL WHERE id = $1 AND attempts = $2", [job.id, job.attempts]); }
  async cleanup() { await this.pool.query('DELETE FROM shopping_sessions WHERE expires_at < now()'); }
  async health() { await this.pool.query('SELECT 1'); }
  async close() { await this.pool.end(); }
}

// Deliberately ephemeral; only local demo and automated tests. Production refuses it.
export class MemoryStore implements Store {
  private sessions = new Map<string, { owner: string; data: ShoppingSession }>();
  private locks = new Map<string, Promise<unknown>>();
  private jobs = new Map<string, Job & { state: 'queued' | 'running' | 'done' }>();
  async create(owner: string, session: ShoppingSession) {
    if ([...this.sessions.values()].filter(s => s.owner === owner).length >= 15) throw new AppError(429, 'Search limit reached.');
    this.sessions.set(session.id, { owner, data: structuredClone(session) });
  }
  async latest(owner: string) { return structuredClone([...this.sessions.values()].filter(s => s.owner === owner).at(-1)?.data ?? null); }
  async get(id: string, owner?: string) {
    const entry = this.sessions.get(id);
    if (!entry || (owner && entry.owner !== owner)) throw notFound();
    return structuredClone(entry.data);
  }
  async mutate(id: string, owner: string | null, action: (session: ShoppingSession) => Promise<void> | void) {
    const before = this.locks.get(id) ?? Promise.resolve();
    const task = before.catch(() => {}).then(async () => {
      const session = await this.get(id, owner ?? undefined);
      await action(session);
      session.version++; session.updatedAt = new Date().toISOString();
      this.sessions.get(id)!.data = structuredClone(session);
      for (const round of session.rounds.filter(r => r.status === 'queued')) {
        if (!this.jobs.has(round.id)) this.jobs.set(round.id, { id: round.id, sessionId: id, attempts: 0, state: 'queued' });
      }
      return session;
    });
    this.locks.set(id, task);
    try { return await task; } finally { if (this.locks.get(id) === task) this.locks.delete(id); }
  }
  async delete(id: string, owner: string) {
    if (this.sessions.get(id)?.owner === owner) {
      this.sessions.delete(id);
      for (const [key, job] of this.jobs) if (job.sessionId === id) this.jobs.delete(key);
    }
  }
  async claim() {
    const job = [...this.jobs.values()].find(j => j.state === 'queued');
    if (!job) return null;
    job.state = 'running'; job.attempts++;
    return { id: job.id, sessionId: job.sessionId, attempts: job.attempts };
  }
  async finish(job: Job) { const entry = this.jobs.get(job.id); if (entry) entry.state = 'done'; }
  async cleanup() {}
  async health() {}
  async close() {}
}
