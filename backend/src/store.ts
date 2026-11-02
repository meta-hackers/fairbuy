import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  EMPTY_CONFIG, rankProducts,
  type AttrValue, type ChatMessage, type DiscoveryContext, type DiscoveryRound, type Feedback,
  type Field, type FinalPrice, type Offer, type Product, type Requirement, type ShoppingConfig, type ShoppingSession, type Source,
} from '@fairbuy/core';
import { AppError } from './errors';
import { logger } from './logger';
import type { SessionStartup } from './session-startup';

export interface Job { id: string; sessionId: string; attempts: number }
export interface SessionRevision {
  version: number; parentVersion: number | null; kind: 'created' | 'migrated' | 'changed' | 'archived';
  archived: boolean; revokedFeedbackIds: string[]; createdAt: string; session: ShoppingSession;
}
type Change = (session: ShoppingSession) => undefined;
export interface Store {
  listSessions(query: { search: string; stage: string; mode: string; page: number }): Promise<{ sessions: SessionSummary[]; total: number }>;
  create(owner: string, session: ShoppingSession, startup: SessionStartup): Promise<void>;
  latest(owner: string): Promise<ShoppingSession | null>;
  get(id: string, owner?: string): Promise<ShoppingSession>;
  // Only synchronous, side-effect-free changes may be retried. AI calls run before append.
  append(id: string, owner: string | null, action: Change, expectedVersion?: number): Promise<ShoppingSession>;
  history(id: string): Promise<SessionRevision[]>;
  archive(id: string, owner: string): Promise<void>;
  purge(id: string): Promise<void>;
  claim(): Promise<Job | null>;
  finish(job: Job): Promise<void>;
  health(): Promise<void>;
  close(): Promise<void>;
}
export interface SessionSummary { id: string; owner: string; stage: string; mode: string; category: string | null; createdAt: string; updatedAt: string; archived: boolean }
const notFound = () => new AppError(404, 'This search was not found or has been closed.', 'NOT_FOUND');
const conflict = () => new AppError(409, 'This search changed while the operation was running. Review the latest state and retry.', 'SESSION_CONFLICT');
function revision(previous: ShoppingSession | null, session: ShoppingSession, kind: SessionRevision['kind']): SessionRevision {
  return {
    version: session.version, parentVersion: previous?.version ?? null, kind, archived: kind === 'archived',
    revokedFeedbackIds: previous?.feedback.filter(f => !session.feedback.some(current => current.id === f.id)).map(f => f.id) ?? [],
    createdAt: session.updatedAt, session: structuredClone(session),
  };
}
function changed(previous: ShoppingSession, action: Change): ShoppingSession | null {
  const next = structuredClone(previous);
  const result: unknown = action(next);
  if (result && typeof (result as Promise<unknown>).then === 'function') throw new Error('Session changes must be synchronous; run external calls before append.');
  for (const field of ['id', 'version', 'createdAt', 'mode', 'askSessionId', 'configureSessionId'] as const) {
    if (next[field] !== previous[field]) throw new Error(`Session identity field ${field} is immutable.`);
  }
  if (JSON.stringify(next) === JSON.stringify(previous)) return null;
  next.version++; next.updatedAt = new Date().toISOString();
  return next;
}
function logQueued(previous: ShoppingSession, next: ShoppingSession) {
  for (const round of next.rounds.filter(r => !previous.rounds.some(prior => prior.id === r.id))) {
    logger.info('discovery.round.queued', {
      sessionId: next.id, version: next.version, roundId: round.id, round: round.number, trigger: round.trigger,
      previousProducts: round.context.previousProducts.length, feedback: round.context.feedback.length,
    });
  }
}

interface SessionRow extends QueryResultRow {
  id: string; owner_hash: string; version: number; mode: 'live' | 'demo'; stage: ShoppingSession['stage'];
  ask_session_id: string; configure_session_id: string; ready: boolean; selected_product_id: string | null;
  created_at: string; updated_at: string;
}
interface ConfigRow extends QueryResultRow {
  session_id?: string; round_id?: string; scope: 'current' | 'initial'; category: string | null; purpose: string | null;
  budget_max: number | string | null; budget_hard: boolean; currency: string; country: string | null; city: string | null;
}
interface RequirementRow extends QueryResultRow {
  session_id?: string; round_id?: string; feedback_id?: string; scope?: 'current' | 'initial'; position: number;
  label: string; hard: boolean; attribute: string | null; op: Requirement['op']; value: Requirement['value']; unit: string | null;
}
interface MessageRow extends QueryResultRow { phase: 'ask' | 'configure'; position: number; role: ChatMessage['role']; content: string }
interface FeedbackRow extends QueryResultRow {
  id: string; position: number; product_id: string | null; product_name: string | null; reason: string; created_at: string;
}
interface RoundRow extends QueryResultRow {
  id: string; number: number; attempt: number; trigger_kind: DiscoveryRound['trigger']; status: DiscoveryRound['status'];
  created_at: string; started_at: string | null; finished_at: string | null; duration_ms: number | string | null;
  summary: string; error: string | null; initial_request: string;
}
interface RoundFeedbackRow extends QueryResultRow {
  round_id: string; feedback_id: string; position: number; product_id: string | null; product_name: string | null; reason: string; created_at: string;
}
interface ProductRow extends QueryResultRow {
  round_id: string; product_id: string; position: number; name: string; summary: string; why: string; image_url: string | null;
}
interface TradeoffRow extends QueryResultRow { round_id: string; product_id: string; position: number; text: string }
interface OfferRow extends QueryResultRow {
  round_id: string; product_id: string; offer_id: string; position: number; category: string; mode: Offer['mode'];
  provenance_url: string; fetched_at: string; availability: Offer['availability']; title: string; seller: string;
  condition_status: 'verified' | 'seller_claim' | 'estimate' | 'unknown'; condition_value: string | null; condition_note: string | null;
  currency: ShoppingConfig['currency']; final_price_cents: number | string | null;
}
interface EvidenceRow extends QueryResultRow {
  round_id: string; product_id: string; offer_id: string; scope: 'offer' | 'condition'; position: number;
  source_type: string; ref: string; snippet: string | null; captured_at: string;
}
interface AttributeRow extends QueryResultRow {
  round_id: string; product_id: string; offer_id: string; attribute_key: string; position: number;
  status: Field<AttrValue>['status']; kind: AttrValue['kind'] | null; number_value: number | string | null;
  text_value: string | null; boolean_value: boolean | null; unit: string | null; note: string | null;
}
interface AttributeEvidenceRow extends QueryResultRow {
  round_id: string; product_id: string; offer_id: string; attribute_key: string; position: number;
  source_type: string; ref: string; snippet: string | null; captured_at: string;
}
interface MissingRow extends QueryResultRow { round_id: string; product_id: string; offer_id: string; position: number; label: string }
interface SourceRow extends QueryResultRow { round_id: string; position: number; url: string; title: string }
interface ChildrenRow extends QueryResultRow {
  configs: ConfigRow[]; config_requirements: RequirementRow[]; missing: { label: string }[];
  messages: MessageRow[]; feedback: FeedbackRow[]; feedback_requirements: RequirementRow[];
  rounds: RoundRow[]; round_configs: ConfigRow[]; round_config_requirements: RequirementRow[];
  round_feedback: RoundFeedbackRow[]; round_feedback_requirements: RequirementRow[];
  products: ProductRow[]; tradeoffs: TradeoffRow[]; offers: OfferRow[]; evidence: EvidenceRow[];
  attributes: AttributeRow[]; attribute_evidence: AttributeEvidenceRow[]; offer_missing: MissingRow[]; sources: SourceRow[];
}
const key = (...parts: (string | number)[]) => parts.join('\u0000');
const iso = (value: string | Date | null | undefined) => value == null ? null : typeof value === 'string' ? value : value.toISOString();
const number = (value: number | string | null) => value == null ? null : Number(value);
const group = <T>(rows: T[], by: (row: T) => string) => {
  const map = new Map<string, T[]>();
  for (const row of rows) { const k = by(row); map.set(k, [...(map.get(k) ?? []), row]); }
  return map;
};
function buildConfig(row: ConfigRow | undefined, requirements: RequirementRow[]): ShoppingConfig {
  return {
    category: row?.category ?? null, purpose: row?.purpose ?? null,
    budgetMax: number(row?.budget_max ?? null), budgetHard: row?.budget_hard ?? false,
    currency: (row?.currency ?? 'EUR') as ShoppingConfig['currency'],
    country: row?.country ?? null, city: row?.city ?? null,
    requirements: requirements.map(r => ({
      label: r.label, hard: r.hard, attribute: r.attribute, op: r.op, value: r.value, unit: r.unit,
    })),
  };
}
function buildFeedback(rows: RoundFeedbackRow[], requirements: RequirementRow[]): Feedback[] {
  const learned = group(requirements, r => String(r.feedback_id));
  return rows.map(row => ({
    id: row.feedback_id, productId: row.product_id, productName: row.product_name, reason: row.reason,
    at: iso(row.created_at)!, learned: (learned.get(row.feedback_id) ?? []).map(r => ({
      label: r.label, hard: r.hard, attribute: r.attribute, op: r.op, value: r.value, unit: r.unit,
    })),
  }));
}

// Legacy rows were one JSON document. The old price components included destination-
// dependent shipping/fees; migration keeps only the stated item price.
export function normalizeLegacySession(raw: Record<string, any>): ShoppingSession {
  const now = new Date().toISOString();
  const config = (raw.config ?? EMPTY_CONFIG) as ShoppingConfig;
  const rounds = (Array.isArray(raw.rounds) ? raw.rounds : []).map((round: Record<string, any>): DiscoveryRound => {
    const context = (round.context ?? {}) as DiscoveryContext;
    const products = (Array.isArray(round.products) ? round.products : []).map((product: Record<string, any>): Product => ({
      id: String(product.id), name: String(product.name ?? ''), summary: String(product.summary ?? ''),
      why: String(product.why ?? ''), tradeoffs: Array.isArray(product.tradeoffs) ? product.tradeoffs.map(String) : [],
      imageUrl: typeof product.imageUrl === 'string' ? product.imageUrl : null,
      offers: (Array.isArray(product.offers) ? product.offers : []).map((offer: Record<string, any>): Offer => {
        const legacyPrice = offer.price ?? {};
        const item = Array.isArray(legacyPrice.components) ? legacyPrice.components.find((c: Record<string, any>) => c.kind === 'item') : null;
        const price: FinalPrice = {
          currency: legacyPrice.currency ?? config.currency,
          amountCents: typeof legacyPrice.amountCents === 'number' ? legacyPrice.amountCents
            : item && item.status !== 'unknown' && typeof item.amountCents === 'number' ? item.amountCents : null,
        };
        return { ...offer, price } as Offer;
      }),
    }));
    const createdAt = round.createdAt ?? now;
    const finishedAt = round.finishedAt ?? null;
    return {
      id: round.id, number: round.number, attempt: round.attempt ?? 0, trigger: round.trigger ?? 'configure', status: round.status ?? 'queued',
      createdAt, startedAt: round.startedAt ?? createdAt, finishedAt,
      durationMs: typeof round.durationMs === 'number' ? round.durationMs : finishedAt ? Math.max(0, Date.parse(finishedAt) - Date.parse(round.startedAt ?? createdAt)) : null,
      products, sources: Array.isArray(round.sources) ? round.sources : [], summary: round.summary ?? '', error: round.error ?? null,
      context: {
        sessionId: raw.id, discoverySessionId: round.id, initialRequest: context.initialRequest ?? '',
        initialConfig: context.initialConfig ?? config, config: context.config ?? config,
        previousProducts: context.previousProducts ?? [], discardedProducts: context.discardedProducts ?? [], feedback: context.feedback ?? [],
      },
      ranking: null,
    };
  });
  return {
    id: raw.id, version: raw.version ?? 0, mode: raw.mode ?? 'demo', createdAt: raw.createdAt ?? now, updatedAt: raw.updatedAt ?? now,
    stage: raw.stage ?? 'ask', askSessionId: raw.askSessionId ?? randomUUID(), configureSessionId: raw.configureSessionId ?? randomUUID(),
    askMessages: Array.isArray(raw.askMessages) ? raw.askMessages : [], configureMessages: Array.isArray(raw.configureMessages) ? raw.configureMessages : [],
    config, initialConfig: raw.initialConfig ?? null, ready: !!raw.ready, missing: Array.isArray(raw.missing) ? raw.missing : [],
    feedback: Array.isArray(raw.feedback) ? raw.feedback : [], rounds, selectedProductId: raw.selectedProductId ?? null,
  };
}

const CHILDREN_SQL = `
SELECT
  COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.scope) FROM session_configs x WHERE x.session_id = $1), '[]'::jsonb) AS configs,
  COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.scope, x.position) FROM session_config_requirements x WHERE x.session_id = $1), '[]'::jsonb) AS config_requirements,
  COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.position) FROM session_missing x WHERE x.session_id = $1), '[]'::jsonb) AS missing,
  COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.phase, x.position) FROM session_messages x WHERE x.session_id = $1), '[]'::jsonb) AS messages,
  COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.position) FROM session_feedback x WHERE x.session_id = $1), '[]'::jsonb) AS feedback,
  COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.feedback_id, x.position) FROM feedback_requirements x JOIN session_feedback f ON f.id = x.feedback_id WHERE f.session_id = $1), '[]'::jsonb) AS feedback_requirements,
  COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.number) FROM discovery_rounds x WHERE x.session_id = $1), '[]'::jsonb) AS rounds,
  COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.round_id, x.scope) FROM round_configs x JOIN discovery_rounds r ON r.id = x.round_id WHERE r.session_id = $1), '[]'::jsonb) AS round_configs,
  COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.round_id, x.scope, x.position) FROM round_config_requirements x JOIN discovery_rounds r ON r.id = x.round_id WHERE r.session_id = $1), '[]'::jsonb) AS round_config_requirements,
  COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.round_id, x.position) FROM round_feedback x JOIN discovery_rounds r ON r.id = x.round_id WHERE r.session_id = $1), '[]'::jsonb) AS round_feedback,
  COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.round_id, x.feedback_id, x.position) FROM round_feedback_requirements x JOIN discovery_rounds r ON r.id = x.round_id WHERE r.session_id = $1), '[]'::jsonb) AS round_feedback_requirements,
  COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.round_id, x.position) FROM round_products x JOIN discovery_rounds r ON r.id = x.round_id WHERE r.session_id = $1), '[]'::jsonb) AS products,
  COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.round_id, x.product_id, x.position) FROM round_product_tradeoffs x JOIN discovery_rounds r ON r.id = x.round_id WHERE r.session_id = $1), '[]'::jsonb) AS tradeoffs,
  COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.round_id, x.product_id, x.position) FROM round_offers x JOIN discovery_rounds r ON r.id = x.round_id WHERE r.session_id = $1), '[]'::jsonb) AS offers,
  COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.round_id, x.product_id, x.offer_id, x.scope, x.position) FROM round_offer_evidence x JOIN discovery_rounds r ON r.id = x.round_id WHERE r.session_id = $1), '[]'::jsonb) AS evidence,
  COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.round_id, x.product_id, x.offer_id, x.position) FROM round_offer_attributes x JOIN discovery_rounds r ON r.id = x.round_id WHERE r.session_id = $1), '[]'::jsonb) AS attributes,
  COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.round_id, x.product_id, x.offer_id, x.attribute_key, x.position) FROM round_offer_attribute_evidence x JOIN discovery_rounds r ON r.id = x.round_id WHERE r.session_id = $1), '[]'::jsonb) AS attribute_evidence,
  COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.round_id, x.product_id, x.offer_id, x.position) FROM round_offer_missing x JOIN discovery_rounds r ON r.id = x.round_id WHERE r.session_id = $1), '[]'::jsonb) AS offer_missing,
  COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.round_id, x.position) FROM round_sources x JOIN discovery_rounds r ON r.id = x.round_id WHERE r.session_id = $1), '[]'::jsonb) AS sources
`;

export class PostgresStore implements Store {
  readonly pool: Pool;
  constructor(url: string) {
    this.pool = new Pool({
      connectionString: url, max: 3, connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10000, statement_timeout: 15000,
    });
  }
  async migrate() {
    // Idempotent DDL, serialized across overlapping Render deployments.
    const client = await this.pool.connect();
    const started = Date.now();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(731692401)');
      await client.query(await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8'));
      await client.query(await readFile(new URL('../migrations/002_backoffice.sql', import.meta.url), 'utf8'));
      await client.query(await readFile(new URL('../migrations/003_session_startup.sql', import.meta.url), 'utf8'));
      const legacyColumn = await client.query("SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'shopping_sessions' AND column_name = 'data'");
      let migrated = 0;
      if (legacyColumn.rowCount) {
        const legacy = await client.query<{ id: string; owner_hash: string; data: unknown }>('SELECT id, owner_hash, data FROM shopping_sessions WHERE data IS NOT NULL');
        logger.info('database.legacy_sessions.found', { sessions: legacy.rowCount });
        for (const row of legacy.rows) {
          try {
            const session = normalizeLegacySession(row.data as Record<string, any>);
            await this.writeLegacySession(client, session, row.owner_hash);
            migrated++;
          } catch (error) {
            logger.error('database.legacy_session.failed', { sessionId: row.id, error: error instanceof Error ? error.name : 'unknown' });
            throw error; // Abort the migration instead of silently deleting historical data.
          }
        }
        await client.query('ALTER TABLE shopping_sessions DROP COLUMN IF EXISTS data');
      }
      await client.query(await readFile(new URL('../migrations/004_session_versions.sql', import.meta.url), 'utf8'));
      // A single baseline preserves the state available at upgrade time. Earlier
      // revisions cannot be reconstructed from the old mutable tables.
      const baselines = await client.query<{ id: string }>('SELECT id FROM shopping_sessions s WHERE NOT EXISTS (SELECT 1 FROM session_versions v WHERE v.session_id = s.id)');
      for (const row of baselines.rows) {
        const session = await this.readLegacySession(client, row.id);
        if (session) await this.insertRevision(client, revision(null, session, 'migrated'));
      }
      await client.query('COMMIT');
      logger.info('database.migrated', { durationMs: Date.now() - started, legacySessionsMigrated: migrated, droppedLegacyDataColumn: !!legacyColumn.rowCount });
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async create(owner: string, session: ShoppingSession, startup: SessionStartup) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [owner]);
      const count = await client.query(`SELECT count(*) FROM shopping_sessions s
        CROSS JOIN LATERAL (SELECT archived FROM session_versions WHERE session_id = s.id ORDER BY version DESC LIMIT 1) v
        WHERE owner_hash = $1 AND NOT v.archived`, [owner]);
      if (Number(count.rows[0].count) >= 15) throw new AppError(429, 'Search limit reached. Close an older search before starting another.');
      await client.query(`INSERT INTO shopping_sessions
        (id, owner_hash, version, mode, stage, ask_session_id, configure_session_id, ready, selected_product_id, created_at, updated_at, startup_config)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
      [session.id, owner, session.version, session.mode, session.stage, session.askSessionId, session.configureSessionId,
        session.ready, session.selectedProductId, session.createdAt, session.updatedAt, JSON.stringify(startup)]);
      await this.insertRevision(client, revision(null, session, 'created'));
      await client.query('COMMIT');
      logger.info('database.session.created', { sessionId: session.id, version: session.version });
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async latest(owner: string) {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ state: ShoppingSession }>(`SELECT v.state FROM shopping_sessions s
        CROSS JOIN LATERAL (SELECT state, archived FROM session_versions WHERE session_id = s.id ORDER BY version DESC LIMIT 1) v
        WHERE s.owner_hash = $1 AND NOT v.archived ORDER BY s.created_at DESC, s.id DESC LIMIT 1`, [owner]);
      if (!result.rows[0]) return null;
      return result.rows[0].state;
    } finally { client.release(); }
  }
  async listSessions(query: { search: string; stage: string; mode: string; page: number }) {
    const values = [query.search, query.stage, query.mode];
    const where = `FROM shopping_sessions s
      CROSS JOIN LATERAL (SELECT state, archived FROM session_versions WHERE session_id = s.id ORDER BY version DESC LIMIT 1) v
      WHERE ($1 = '' OR strpos(lower(s.id::text), lower($1)) > 0 OR strpos(lower(s.owner_hash), lower($1)) > 0 OR strpos(lower(COALESCE(v.state->'config'->>'category', '')), lower($1)) > 0)
      AND ($2 = '' OR v.state->>'stage' = $2) AND ($3 = '' OR s.mode = $3)`;
    const total = await this.pool.query(`SELECT count(*) ${where}`, values);
    const result = await this.pool.query(`SELECT s.id, s.owner_hash AS owner, v.state->>'stage' AS stage, s.mode, v.archived,
      v.state->'config'->>'category' AS category, s.created_at AS "createdAt", v.state->>'updatedAt' AS "updatedAt" ${where}
      ORDER BY s.created_at DESC, s.id LIMIT 30 OFFSET $4`, [...values, (query.page - 1) * 30]);
    return { sessions: result.rows as SessionSummary[], total: Number(total.rows[0].count) };
  }
  async get(id: string, owner?: string): Promise<ShoppingSession> {
    const result = await this.pool.query<{ state: ShoppingSession; archived: boolean }>(`SELECT v.state, v.archived FROM shopping_sessions s
      CROSS JOIN LATERAL (SELECT state, archived FROM session_versions WHERE session_id = s.id ORDER BY version DESC LIMIT 1) v
      WHERE s.id = $1 AND ($2::text IS NULL OR s.owner_hash = $2)`, [id, owner ?? null]);
    const row = result.rows[0];
    if (!row || (owner !== undefined && row.archived)) throw notFound();
    return row.state;
  }
  async history(id: string): Promise<SessionRevision[]> {
    await this.get(id);
    const result = await this.pool.query(`SELECT version, parent_version AS "parentVersion", kind, archived,
      revoked_feedback_ids AS "revokedFeedbackIds", created_at AS "createdAt", state AS session
      FROM session_versions WHERE session_id = $1 ORDER BY version`, [id]);
    return result.rows.map(row => ({ ...row, createdAt: iso(row.createdAt)! })) as SessionRevision[];
  }
  async append(id: string, owner: string | null, action: Change, expectedVersion?: number) {
    const started = Date.now();
    for (let attempt = 0; attempt < 5; attempt++) {
      const rows = await this.pool.query<{ archived: boolean; state: ShoppingSession }>(`SELECT v.archived, v.state FROM shopping_sessions s
        CROSS JOIN LATERAL (SELECT archived, state FROM session_versions WHERE session_id = s.id ORDER BY version DESC LIMIT 1) v
        WHERE s.id = $1 AND ($2::text IS NULL OR s.owner_hash = $2)`, [id, owner]);
      const current = rows.rows[0];
      if (!current || current.archived) throw notFound();
      if (expectedVersion !== undefined && current.state.version !== expectedVersion) throw conflict();
      const next = changed(current.state, action);
      if (!next) return current.state;
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await this.insertRevision(client, revision(current.state, next, 'changed'));
        await this.enqueue(client, next);
        await client.query('COMMIT');
        logger.info('database.session.appended', { sessionId: id, version: next.version, parentVersion: current.state.version, durationMs: Date.now() - started });
        logQueued(current.state, next);
        return next;
      } catch (error) {
        await client.query('ROLLBACK');
        const code = (error as { code?: string }).code;
        if (code === '23503') throw notFound(); // Purged concurrently; never recreate a session.
        if (code !== '23505') throw error;
        if (expectedVersion !== undefined) throw conflict();
      } finally { client.release(); }
    }
    throw conflict();
  }
  async archive(id: string, owner: string) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const rows = await this.pool.query<{ state: ShoppingSession; archived: boolean }>(`SELECT v.state, v.archived FROM shopping_sessions s
        CROSS JOIN LATERAL (SELECT state, archived FROM session_versions WHERE session_id = s.id ORDER BY version DESC LIMIT 1) v
        WHERE s.id = $1 AND s.owner_hash = $2`, [id, owner]);
      const current = rows.rows[0];
      if (!current || current.archived) return;
      const next = structuredClone(current.state); next.version++; next.updatedAt = new Date().toISOString();
      const client = await this.pool.connect();
      try {
        await this.insertRevision(client, revision(current.state, next, 'archived'));
        logger.info('session.archived', { sessionId: id, version: next.version });
        return;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === '23503') return;
        if (code !== '23505') throw error;
      } finally { client.release(); }
    }
    throw conflict();
  }
  async purge(id: string) {
    const result = await this.pool.query('DELETE FROM shopping_sessions WHERE id = $1', [id]);
    if (result.rowCount) logger.warn('maintenance.session.purged', { sessionId: id });
  }
  async claim(): Promise<Job | null> {
    const result = await this.pool.query(`
      UPDATE discovery_jobs SET state = 'running', attempts = attempts + 1, lease_until = now() + interval '5 minutes'
      WHERE id = (SELECT j.id FROM discovery_jobs j
        CROSS JOIN LATERAL (SELECT archived FROM session_versions WHERE session_id = j.session_id ORDER BY version DESC LIMIT 1) v
        WHERE NOT v.archived AND (j.state = 'queued' OR (j.state = 'running' AND j.lease_until < now()))
        ORDER BY j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1)
      RETURNING id, session_id, attempts`);
    const row = result.rows[0];
    return row ? { id: row.id, sessionId: row.session_id, attempts: row.attempts } : null;
  }
  async finish(job: Job) { await this.pool.query("UPDATE discovery_jobs SET state = 'done', lease_until = NULL WHERE id = $1 AND attempts = $2", [job.id, job.attempts]); }
  async health() { await this.pool.query('SELECT 1'); }
  async close() { await this.pool.end(); }

  private async insertRevision(client: PoolClient, entry: SessionRevision) {
    await client.query(`INSERT INTO session_versions (session_id, version, parent_version, kind, archived, revoked_feedback_ids, state, created_at)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)`,
    [entry.session.id, entry.version, entry.parentVersion, entry.kind, entry.archived, JSON.stringify(entry.revokedFeedbackIds), JSON.stringify(entry.session), entry.createdAt]);
  }

  // Migration-only reader/writer for the former normalized mutable state.
  private async readLegacySession(client: PoolClient, id: string): Promise<ShoppingSession | null> {
    const result = await client.query<SessionRow>(
      'SELECT * FROM shopping_sessions WHERE id = $1', [id],
    );
    const row = result.rows[0];
    if (!row) return null;
    const data = (await client.query<ChildrenRow>(CHILDREN_SQL, [id])).rows[0];

    const configRequirements = group(data.config_requirements, r => String(r.scope));
    const configs = new Map(data.configs.map(c => [c.scope, c]));
    const config = buildConfig(configs.get('current'), configRequirements.get('current') ?? []);
    const initialConfig = configs.has('initial') ? buildConfig(configs.get('initial'), configRequirements.get('initial') ?? []) : null;

    const askMessages: ChatMessage[] = data.messages.filter(m => m.phase === 'ask').map(m => ({ role: m.role, content: m.content }));
    const configureMessages: ChatMessage[] = data.messages.filter(m => m.phase === 'configure').map(m => ({ role: m.role, content: m.content }));
    const learned = group(data.feedback_requirements, r => String(r.feedback_id));
    const feedback: Feedback[] = data.feedback.map(f => ({
      id: f.id, productId: f.product_id, productName: f.product_name, reason: f.reason, at: iso(f.created_at)!,
      learned: (learned.get(f.id) ?? []).map(r => ({ label: r.label, hard: r.hard, attribute: r.attribute, op: r.op, value: r.value, unit: r.unit })),
    }));

    const roundConfigs = new Map(data.round_configs.map(c => [key(c.round_id!, c.scope), c]));
    const roundConfigRequirements = group(data.round_config_requirements, r => key(r.round_id!, r.scope!));
    const roundFeedback = group(data.round_feedback, r => String(r.round_id));
    const tradeoffs = group(data.tradeoffs, t => key(t.round_id, t.product_id));
    const offerRows = group(data.offers, o => key(o.round_id, o.product_id));
    const evidence = group(data.evidence, e => key(e.round_id, e.product_id, e.offer_id, e.scope));
    const attributes = group(data.attributes, a => key(a.round_id, a.product_id, a.offer_id));
    const attributeEvidence = group(data.attribute_evidence, e => key(e.round_id, e.product_id, e.offer_id, e.attribute_key));
    const offerMissing = group(data.offer_missing, m => key(m.round_id, m.product_id, m.offer_id));
    const sources = group(data.sources, s => String(s.round_id));

    const buildOffer = (offer: OfferRow): Offer => {
      const offerKey = key(offer.round_id, offer.product_id, offer.offer_id);
      const offerEvidence = (evidence.get(key(offer.round_id, offer.product_id, offer.offer_id, 'offer')) ?? []).map(e => ({
        sourceType: e.source_type as 'url' | 'screenshot' | 'user_input', ref: e.ref, snippet: e.snippet ?? undefined, at: iso(e.captured_at)!,
      }));
      const conditionEvidence = (evidence.get(key(offer.round_id, offer.product_id, offer.offer_id, 'condition')) ?? []).map(e => ({
        sourceType: e.source_type as 'url' | 'screenshot' | 'user_input', ref: e.ref, snippet: e.snippet ?? undefined, at: iso(e.captured_at)!,
      }));
      const condition: Offer['condition'] = offer.condition_status === 'unknown' ? { status: 'unknown' }
        : offer.condition_status === 'estimate' ? { status: 'estimate', value: offer.condition_value as 'new' | 'refurbished' | 'used', note: offer.condition_note ?? '' }
        : { status: offer.condition_status, value: offer.condition_value as 'new' | 'refurbished' | 'used', evidence: conditionEvidence.length ? conditionEvidence : offerEvidence };
      const offerAttributes: Record<string, Field<AttrValue>> = {};
      for (const attr of attributes.get(offerKey) ?? []) {
        const attrEvidence = (attributeEvidence.get(key(offer.round_id, offer.product_id, offer.offer_id, attr.attribute_key)) ?? []).map(e => ({
          sourceType: e.source_type as 'url' | 'screenshot' | 'user_input', ref: e.ref, snippet: e.snippet ?? undefined, at: iso(e.captured_at)!,
        }));
        if (attr.status === 'unknown') { offerAttributes[attr.attribute_key] = { status: 'unknown' }; continue; }
        if (attr.status === 'estimate') {
          const value = buildAttrValue(attr);
          if (value) offerAttributes[attr.attribute_key] = { status: 'estimate', value, note: attr.note ?? '' };
          continue;
        }
        const value = buildAttrValue(attr);
        if (value) offerAttributes[attr.attribute_key] = { status: attr.status, value, evidence: attrEvidence };
      }
      return {
        schemaVersion: 1, id: offer.offer_id, category: offer.category, mode: offer.mode, provenanceUrl: offer.provenance_url,
        fetchedAt: iso(offer.fetched_at)!, availability: offer.availability, title: offer.title, seller: offer.seller,
        condition, price: { currency: offer.currency, amountCents: number(offer.final_price_cents) },
        attributes: offerAttributes, missing: (offerMissing.get(offerKey) ?? []).map(m => m.label), evidence: offerEvidence,
      };
    };

    const productsByRound = new Map<string, Product[]>();
    for (const round of data.rounds) {
      const products = data.products.filter(p => p.round_id === round.id).map((p): Product => ({
        id: p.product_id, name: p.name, summary: p.summary, why: p.why, imageUrl: p.image_url,
        tradeoffs: (tradeoffs.get(key(p.round_id, p.product_id)) ?? []).map(t => t.text),
        offers: (offerRows.get(key(p.round_id, p.product_id)) ?? []).map(buildOffer),
      }));
      productsByRound.set(round.id, products);
    }

    const rounds: DiscoveryRound[] = [];
    for (const round of data.rounds) {
      const products = productsByRound.get(round.id) ?? [];
      const previousProducts: Product[] = []; const seen = new Set<string>();
      for (const prior of rounds) for (const product of prior.products) {
        if (!seen.has(product.id)) { seen.add(product.id); previousProducts.push(product); }
      }
      const feedbackRows = roundFeedback.get(round.id) ?? [];
      const contextFeedback = buildFeedback(feedbackRows, data.round_feedback_requirements.filter(r => r.round_id === round.id));
      const discarded = new Set(feedbackRows.map(f => f.product_id).filter(Boolean));
      const context: DiscoveryContext = {
        sessionId: row.id, discoverySessionId: round.id, initialRequest: round.initial_request,
        initialConfig: buildConfig(roundConfigs.get(key(round.id, 'initial')), roundConfigRequirements.get(key(round.id, 'initial')) ?? []),
        config: buildConfig(roundConfigs.get(key(round.id, 'current')), roundConfigRequirements.get(key(round.id, 'current')) ?? []),
        previousProducts, discardedProducts: previousProducts.filter(p => discarded.has(p.id)), feedback: contextFeedback,
      };
      rounds.push({
        id: round.id, number: round.number, attempt: round.attempt, trigger: round.trigger_kind, status: round.status,
        createdAt: iso(round.created_at)!, startedAt: iso(round.started_at), finishedAt: iso(round.finished_at),
        durationMs: number(round.duration_ms),
        products, sources: (sources.get(round.id) ?? []).map((s): Source => ({ url: s.url, title: s.title })),
        summary: round.summary, error: round.error, context,
        ranking: products.length || round.status !== 'queued' ? rankProducts(products, context) : null,
      });
    }

    return {
      id: row.id, version: row.version, mode: row.mode, createdAt: iso(row.created_at)!, updatedAt: iso(row.updated_at)!,
      stage: row.stage, askSessionId: row.ask_session_id, configureSessionId: row.configure_session_id,
      askMessages, configureMessages, config, initialConfig, ready: row.ready,
      missing: data.missing.map(m => m.label), feedback, rounds, selectedProductId: row.selected_product_id,
    };
  }

  // Used only to upgrade pre-normalization JSONB rows, before immutability guards.
  private async writeLegacySession(client: PoolClient, session: ShoppingSession, owner: string) {
    await client.query(`
        INSERT INTO shopping_sessions (id, owner_hash, version, mode, stage, ask_session_id, configure_session_id, ready, selected_product_id, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, mode = EXCLUDED.mode, stage = EXCLUDED.stage,
          ask_session_id = EXCLUDED.ask_session_id, configure_session_id = EXCLUDED.configure_session_id,
          ready = EXCLUDED.ready, selected_product_id = EXCLUDED.selected_product_id,
          created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at`,
        [session.id, owner, session.version, session.mode, session.stage, session.askSessionId, session.configureSessionId,
          session.ready, session.selectedProductId, session.createdAt, session.updatedAt]);
    await this.replaceLegacyChildren(client, session);
  }

  private async replaceLegacyChildren(client: PoolClient, session: ShoppingSession) {
    const id = session.id;
    await client.query('DELETE FROM discovery_rounds WHERE session_id = $1', [id]);
    await client.query('DELETE FROM session_feedback WHERE session_id = $1', [id]);
    await client.query('DELETE FROM session_messages WHERE session_id = $1', [id]);
    await client.query('DELETE FROM session_missing WHERE session_id = $1', [id]);
    await client.query('DELETE FROM session_config_requirements WHERE session_id = $1', [id]);
    await client.query('DELETE FROM session_configs WHERE session_id = $1', [id]);

    const configs: Record<string, unknown>[] = [];
    const requirements: Record<string, unknown>[] = [];
    const addConfig = (config: ShoppingConfig, scope: 'current' | 'initial') => {
      configs.push({
        session_id: id, scope, category: config.category, purpose: config.purpose, budget_max: config.budgetMax,
        budget_hard: config.budgetHard, currency: config.currency, country: config.country, city: config.city,
      });
      config.requirements.forEach((r, position) => requirements.push({
        session_id: id, scope, position, label: r.label, hard: r.hard, attribute: r.attribute, op: r.op,
        value: JSON.stringify(r.value), unit: r.unit,
      }));
    };
    addConfig(session.config, 'current');
    if (session.initialConfig) addConfig(session.initialConfig, 'initial');
    await this.insertRows(client, 'session_configs', ['session_id', 'scope', 'category', 'purpose', 'budget_max', 'budget_hard', 'currency', 'country', 'city'], configs);
    await this.insertRows(client, 'session_config_requirements', ['session_id', 'scope', 'position', 'label', 'hard', 'attribute', 'op', 'value', 'unit'], requirements);

    await this.insertRows(client, 'session_missing', ['session_id', 'position', 'label'],
      session.missing.map((label, position) => ({ session_id: id, position, label })));
    await this.insertRows(client, 'session_messages', ['session_id', 'phase', 'position', 'role', 'content'], [
      ...session.askMessages.map((m, position) => ({ session_id: id, phase: 'ask', position, role: m.role, content: m.content })),
      ...session.configureMessages.map((m, position) => ({ session_id: id, phase: 'configure', position, role: m.role, content: m.content })),
    ]);

    const feedbackRows: Record<string, unknown>[] = [];
    const feedbackRequirements: Record<string, unknown>[] = [];
    session.feedback.forEach((feedback, position) => {
      feedbackRows.push({
        id: feedback.id, session_id: id, position, product_id: feedback.productId,
        product_name: feedback.productName, reason: feedback.reason, created_at: feedback.at,
      });
      feedback.learned.forEach((r, learnedPosition) => feedbackRequirements.push({
        feedback_id: feedback.id, position: learnedPosition, label: r.label, hard: r.hard, attribute: r.attribute,
        op: r.op, value: JSON.stringify(r.value), unit: r.unit,
      }));
    });
    await this.insertRows(client, 'session_feedback', ['id', 'session_id', 'position', 'product_id', 'product_name', 'reason', 'created_at'], feedbackRows);
    await this.insertRows(client, 'feedback_requirements', ['feedback_id', 'position', 'label', 'hard', 'attribute', 'op', 'value', 'unit'], feedbackRequirements);

    const rounds: Record<string, unknown>[] = [];
    const roundConfigs: Record<string, unknown>[] = [];
    const roundRequirements: Record<string, unknown>[] = [];
    const roundFeedback: Record<string, unknown>[] = [];
    const roundFeedbackRequirements: Record<string, unknown>[] = [];
    const products: Record<string, unknown>[] = [];
    const tradeoffs: Record<string, unknown>[] = [];
    const offers: Record<string, unknown>[] = [];
    const evidence: Record<string, unknown>[] = [];
    const attributes: Record<string, unknown>[] = [];
    const attributeEvidence: Record<string, unknown>[] = [];
    const offerMissing: Record<string, unknown>[] = [];
    const sources: Record<string, unknown>[] = [];

    for (const round of session.rounds) {
      rounds.push({
        id: round.id, session_id: id, number: round.number, attempt: round.attempt, trigger_kind: round.trigger,
        status: round.status, created_at: round.createdAt, started_at: round.startedAt, finished_at: round.finishedAt,
        duration_ms: round.durationMs, summary: round.summary, error: round.error, initial_request: round.context.initialRequest,
      });
      const addRoundConfig = (config: ShoppingConfig, scope: 'current' | 'initial') => {
        roundConfigs.push({
          round_id: round.id, scope, category: config.category, purpose: config.purpose, budget_max: config.budgetMax,
          budget_hard: config.budgetHard, currency: config.currency, country: config.country, city: config.city,
        });
        config.requirements.forEach((r, position) => roundRequirements.push({
          round_id: round.id, scope, position, label: r.label, hard: r.hard, attribute: r.attribute, op: r.op,
          value: JSON.stringify(r.value), unit: r.unit,
        }));
      };
      addRoundConfig(round.context.initialConfig, 'initial');
      addRoundConfig(round.context.config, 'current');
      round.context.feedback.forEach((feedback, position) => {
        roundFeedback.push({
          round_id: round.id, feedback_id: feedback.id, position, product_id: feedback.productId,
          product_name: feedback.productName, reason: feedback.reason, created_at: feedback.at,
        });
        feedback.learned.forEach((r, learnedPosition) => roundFeedbackRequirements.push({
          round_id: round.id, feedback_id: feedback.id, position: learnedPosition, label: r.label, hard: r.hard,
          attribute: r.attribute, op: r.op, value: JSON.stringify(r.value), unit: r.unit,
        }));
      });
      round.products.forEach((product, position) => {
        products.push({
          round_id: round.id, product_id: product.id, position, name: product.name, summary: product.summary,
          why: product.why, image_url: product.imageUrl,
        });
        product.tradeoffs.forEach((text, tradeoffPosition) => tradeoffs.push({
          round_id: round.id, product_id: product.id, position: tradeoffPosition, text,
        }));
        product.offers.forEach((offer, offerPosition) => {
          offers.push({
            round_id: round.id, product_id: product.id, offer_id: offer.id, position: offerPosition,
            category: offer.category, mode: offer.mode, provenance_url: offer.provenanceUrl, fetched_at: offer.fetchedAt,
            availability: offer.availability, title: offer.title, seller: offer.seller,
            condition_status: offer.condition.status, condition_value: offer.condition.status === 'unknown' ? null : offer.condition.value,
            condition_note: offer.condition.status === 'estimate' ? offer.condition.note : null,
            currency: offer.price.currency, final_price_cents: offer.price.amountCents,
          });
          offer.evidence.forEach((item, evidencePosition) => evidence.push({
            round_id: round.id, product_id: product.id, offer_id: offer.id, scope: 'offer', position: evidencePosition,
            source_type: item.sourceType, ref: item.ref, snippet: item.snippet ?? null, captured_at: item.at,
          }));
          if (offer.condition.status === 'verified' || offer.condition.status === 'seller_claim') offer.condition.evidence.forEach((item, evidencePosition) => evidence.push({
            round_id: round.id, product_id: product.id, offer_id: offer.id, scope: 'condition', position: evidencePosition,
            source_type: item.sourceType, ref: item.ref, snippet: item.snippet ?? null, captured_at: item.at,
          }));
          Object.entries(offer.attributes).forEach(([attributeKey, field], attributePosition) => {
            const value = field.status === 'unknown' ? null : field.value;
            attributes.push({
              round_id: round.id, product_id: product.id, offer_id: offer.id, attribute_key: attributeKey,
              position: attributePosition, status: field.status, kind: value?.kind ?? null,
              number_value: value?.kind === 'number' ? value.value : null,
              text_value: value?.kind === 'text' || value?.kind === 'enum' ? value.value : null,
              boolean_value: value?.kind === 'bool' ? value.value : null,
              unit: value?.kind === 'number' ? value.unit : null,
              note: field.status === 'estimate' ? field.note : null,
            });
            if (field.status === 'verified' || field.status === 'seller_claim') field.evidence.forEach((item, evidencePosition) => attributeEvidence.push({
              round_id: round.id, product_id: product.id, offer_id: offer.id, attribute_key: attributeKey,
              position: evidencePosition, source_type: item.sourceType, ref: item.ref, snippet: item.snippet ?? null, captured_at: item.at,
            }));
          });
          offer.missing.forEach((label, missingPosition) => offerMissing.push({
            round_id: round.id, product_id: product.id, offer_id: offer.id, position: missingPosition, label,
          }));
        });
      });
      round.sources.forEach((source, position) => sources.push({ round_id: round.id, position, url: source.url, title: source.title }));
    }

    await this.insertRows(client, 'discovery_rounds', ['id', 'session_id', 'number', 'attempt', 'trigger_kind', 'status', 'created_at', 'started_at', 'finished_at', 'duration_ms', 'summary', 'error', 'initial_request'], rounds);
    await this.insertRows(client, 'round_configs', ['round_id', 'scope', 'category', 'purpose', 'budget_max', 'budget_hard', 'currency', 'country', 'city'], roundConfigs);
    await this.insertRows(client, 'round_config_requirements', ['round_id', 'scope', 'position', 'label', 'hard', 'attribute', 'op', 'value', 'unit'], roundRequirements);
    await this.insertRows(client, 'round_feedback', ['round_id', 'feedback_id', 'position', 'product_id', 'product_name', 'reason', 'created_at'], roundFeedback);
    await this.insertRows(client, 'round_feedback_requirements', ['round_id', 'feedback_id', 'position', 'label', 'hard', 'attribute', 'op', 'value', 'unit'], roundFeedbackRequirements);
    await this.insertRows(client, 'round_products', ['round_id', 'product_id', 'position', 'name', 'summary', 'why', 'image_url'], products);
    await this.insertRows(client, 'round_product_tradeoffs', ['round_id', 'product_id', 'position', 'text'], tradeoffs);
    await this.insertRows(client, 'round_offers', ['round_id', 'product_id', 'offer_id', 'position', 'category', 'mode', 'provenance_url', 'fetched_at', 'availability', 'title', 'seller', 'condition_status', 'condition_value', 'condition_note', 'currency', 'final_price_cents'], offers);
    await this.insertRows(client, 'round_offer_evidence', ['round_id', 'product_id', 'offer_id', 'scope', 'position', 'source_type', 'ref', 'snippet', 'captured_at'], evidence);
    await this.insertRows(client, 'round_offer_attributes', ['round_id', 'product_id', 'offer_id', 'attribute_key', 'position', 'status', 'kind', 'number_value', 'text_value', 'boolean_value', 'unit', 'note'], attributes);
    await this.insertRows(client, 'round_offer_attribute_evidence', ['round_id', 'product_id', 'offer_id', 'attribute_key', 'position', 'source_type', 'ref', 'snippet', 'captured_at'], attributeEvidence);
    await this.insertRows(client, 'round_offer_missing', ['round_id', 'product_id', 'offer_id', 'position', 'label'], offerMissing);
    await this.insertRows(client, 'round_sources', ['round_id', 'position', 'url', 'title'], sources);
  }

  private async insertRows(client: PoolClient, table: string, columns: string[], rows: Record<string, unknown>[]) {
    for (let start = 0; start < rows.length; start += 200) {
      const chunk = rows.slice(start, start + 200);
      const values: unknown[] = [];
      const tuples = chunk.map((row, rowIndex) => `(${columns.map((column, columnIndex) => {
        values.push(row[column] ?? null);
        return `$${rowIndex * columns.length + columnIndex + 1}`;
      }).join(', ')})`);
      await client.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')}`, values);
    }
  }

  private async enqueue(client: PoolClient, session: ShoppingSession) {
    for (const round of session.rounds.filter(r => r.status === 'queued')) {
      await client.query('INSERT INTO discovery_jobs(id, session_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [round.id, session.id]);
    }
  }
}

function buildAttrValue(attr: AttributeRow): AttrValue | null {
  if (attr.kind === 'number' && attr.number_value !== null) return { kind: 'number', value: Number(attr.number_value), unit: attr.unit ?? '' };
  if (attr.kind === 'bool' && attr.boolean_value !== null) return { kind: 'bool', value: attr.boolean_value };
  if (attr.kind === 'enum' && attr.text_value !== null) return { kind: 'enum', value: attr.text_value };
  if (attr.kind === 'text' && attr.text_value !== null) return { kind: 'text', value: attr.text_value };
  return null;
}

// Deliberately ephemeral; only local demo and automated tests. Production refuses it.
export class MemoryStore implements Store {
  private sessions = new Map<string, { owner: string; revisions: SessionRevision[]; startup: SessionStartup }>();
  private jobs = new Map<string, Job & { state: 'queued' | 'running' | 'done' }>();
  async listSessions(query: { search: string; stage: string; mode: string; page: number }) {
    const all = [...this.sessions.values()].map(({ owner, revisions }) => {
      const s = revisions.at(-1)!.session;
      return { id: s.id, owner, stage: s.stage, mode: s.mode, category: s.config.category, createdAt: s.createdAt, updatedAt: s.updatedAt, archived: revisions.at(-1)!.archived };
    })
      .filter(s => (!query.stage || s.stage === query.stage) && (!query.mode || s.mode === query.mode) && [s.id, s.owner, s.category ?? ''].some(value => value.toLowerCase().includes(query.search.toLowerCase())))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { sessions: all.slice((query.page - 1) * 30, query.page * 30), total: all.length };
  }
  async create(owner: string, session: ShoppingSession, startup: SessionStartup) {
    if ([...this.sessions.values()].filter(s => s.owner === owner && !s.revisions.at(-1)!.archived).length >= 15) throw new AppError(429, 'Search limit reached.');
    if (this.sessions.has(session.id)) throw conflict();
    this.sessions.set(session.id, { owner, revisions: [revision(null, session, 'created')], startup: structuredClone(startup) });
  }
  async latest(owner: string) { return structuredClone([...this.sessions.values()].filter(s => s.owner === owner && !s.revisions.at(-1)!.archived).at(-1)?.revisions.at(-1)!.session ?? null); }
  async get(id: string, owner?: string) {
    const entry = this.sessions.get(id);
    if (!entry || (owner !== undefined && (entry.owner !== owner || entry.revisions.at(-1)!.archived))) throw notFound();
    return structuredClone(entry.revisions.at(-1)!.session);
  }
  async history(id: string) {
    const entry = this.sessions.get(id);
    if (!entry) throw notFound();
    return structuredClone(entry.revisions);
  }
  async append(id: string, owner: string | null, action: Change, expectedVersion?: number) {
    const entry = this.sessions.get(id);
    if (!entry || (owner !== null && entry.owner !== owner) || entry.revisions.at(-1)!.archived) throw notFound();
    const previous = entry.revisions.at(-1)!.session;
    if (expectedVersion !== undefined && previous.version !== expectedVersion) throw conflict();
    const next = changed(previous, action);
    if (!next) return structuredClone(previous);
    entry.revisions.push(revision(previous, next, 'changed'));
    for (const round of next.rounds.filter(r => r.status === 'queued')) {
      if (!this.jobs.has(round.id)) this.jobs.set(round.id, { id: round.id, sessionId: id, attempts: 0, state: 'queued' });
    }
    logQueued(previous, next);
    return structuredClone(next);
  }
  async archive(id: string, owner: string) {
    const entry = this.sessions.get(id);
    if (!entry || entry.owner !== owner || entry.revisions.at(-1)!.archived) return;
    const previous = entry.revisions.at(-1)!.session;
    const next = structuredClone(previous); next.version++; next.updatedAt = new Date().toISOString();
    entry.revisions.push(revision(previous, next, 'archived'));
  }
  async purge(id: string) {
    this.sessions.delete(id);
    for (const [jobId, job] of this.jobs) if (job.sessionId === id) this.jobs.delete(jobId);
  }
  async claim() {
    const job = [...this.jobs.values()].find(j => j.state === 'queued' && !this.sessions.get(j.sessionId)?.revisions.at(-1)?.archived);
    if (!job) return null;
    job.state = 'running'; job.attempts++;
    return { id: job.id, sessionId: job.sessionId, attempts: job.attempts };
  }
  async finish(job: Job) { const entry = this.jobs.get(job.id); if (entry && entry.attempts === job.attempts) entry.state = 'done'; }
  async health() {}
  async close() {}
}
