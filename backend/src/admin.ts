import { Router } from 'express';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { SOURCE_ROLES, SOURCE_VERTICALS } from '@fairbuy/core';
import type { Settings } from './settings';
import type { ShoppingService } from './shopping-service';
import { PostgresStore } from './store';
import { SourceCatalogService } from './source-catalog';
import { AppError } from './errors';
import { logger } from './logger';

const derive = promisify(scrypt);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const dummyHash = `scrypt:${'0'.repeat(32)}:${'0'.repeat(128)}`;
export async function passwordHash(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${(await derive(password, salt, 64) as Buffer).toString('hex')}`;
}
export async function verifyPassword(password: string, encoded: string) {
  const [, salt, expected] = encoded.split(':');
  const actual = await derive(password, salt, 64) as Buffer;
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}
interface LoginSession { username: string; credential_hash: string; expires_at: Date }
export function adminRouter(service: ShoppingService, config: Settings, catalog = new SourceCatalogService(config)) {
  const router = Router();
  const pool = service.store instanceof PostgresStore ? service.store.pool : null;
  const sessions = new Map<string, LoginSession>();
  const cookieOptions = { httpOnly: true, secure: config.NODE_ENV === 'production', sameSite: 'strict' as const, path: '/api/admin' };
  router.use((_req, _res, next) => {
    if (!config.BACKOFFICE_ADMINS.length) return next(new AppError(503, 'Backoffice access has not been configured.'));
    next();
  });
  router.post('/login', rateLimit({ windowMs: 15 * 60000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many login attempts. Try again in 15 minutes.' } }), async (req, res) => {
    const { username, password } = z.object({ username: z.string().min(1).max(80), password: z.string().min(1).max(500) }).parse(req.body);
    const admin = config.BACKOFFICE_ADMINS.find(a => a.username.toLowerCase() === username.toLowerCase());
    const valid = await verifyPassword(password, admin?.passwordHash ?? dummyHash);
    if (!admin || !valid) throw new AppError(401, 'Incorrect username or password.');
    const token = randomBytes(32).toString('hex');
    const session = { username: admin.username, credential_hash: digest(admin.passwordHash), expires_at: new Date(Date.now() + 8 * 3600000) };
    const oldToken = req.headers.cookie?.match(/(?:^|;\s*)fairbuy_admin=([a-f0-9]{64})(?:;|$)/)?.[1];
    if (pool) {
      await pool.query('DELETE FROM admin_sessions WHERE expires_at <= now() OR token_hash = $1', [digest(oldToken ?? '')]);
      await pool.query('INSERT INTO admin_sessions(token_hash, username, credential_hash, expires_at) VALUES ($1, $2, $3, $4)', [digest(token), session.username, session.credential_hash, session.expires_at]);
    } else {
      for (const [key, value] of sessions) if (value.expires_at.getTime() <= Date.now() || key === digest(oldToken ?? '')) sessions.delete(key);
      sessions.set(digest(token), session);
    }
    res.cookie('fairbuy_admin', token, { ...cookieOptions, maxAge: 8 * 3600000 });
    res.json({ username: admin.username });
  });
  router.use(async (req, res, next) => {
    const token = req.headers.cookie?.match(/(?:^|;\s*)fairbuy_admin=([a-f0-9]{64})(?:;|$)/)?.[1];
    if (!token) throw new AppError(401, 'Admin login required.');
    const key = digest(token);
    const session: LoginSession | undefined = pool ? (await pool.query('SELECT username, credential_hash, expires_at FROM admin_sessions WHERE token_hash = $1 AND expires_at > now()', [key])).rows[0] : sessions.get(key);
    const admin = config.BACKOFFICE_ADMINS.find(a => a.username === session?.username);
    if (!session || session.expires_at.getTime() <= Date.now() || !admin || session.credential_hash !== digest(admin.passwordHash)) throw new AppError(401, 'Admin login required.');
    res.locals.admin = admin.username; res.locals.adminTokenHash = key;
    next();
  });
  router.get('/me', (_req, res) => res.json({ username: res.locals.admin, persistent: !!pool, retentionDays: null, prices: config.AI_PRICE_TABLE }));
  router.post('/logout', async (_req, res) => {
    if (pool) await pool.query('DELETE FROM admin_sessions WHERE token_hash = $1', [res.locals.adminTokenHash]);
    else sessions.delete(res.locals.adminTokenHash);
    res.clearCookie('fairbuy_admin', cookieOptions); res.status(204).end();
  });
  router.get('/sessions', async (req, res) => {
    const query = z.object({ search: z.string().max(200).default(''), stage: z.enum(['', 'ask', 'configure', 'discovery', 'buy']).default(''), mode: z.enum(['', 'live', 'demo']).default(''), page: z.coerce.number().int().min(1).max(100000).default(1) }).parse(req.query);
    const result = await service.store.listSessions(query);
    const sessions = await Promise.all(result.sessions.map(async session => ({ ...session, usage: summarizeUsage(await service.usage.get(session.id)) })));
    res.json({ ...result, sessions, page: query.page, pageSize: 30 });
  });
  router.get('/sessions/:sessionId', async (req, res) => {
    const id = z.uuid().parse(req.params.sessionId);
    const session = await service.store.get(id);
    const usage = await service.usage.get(id);
    res.json({ session, usage, summary: summarizeUsage(usage) });
  });
  router.get('/sessions/:sessionId/history', async (req, res) => {
    const id = z.uuid().parse(req.params.sessionId);
    res.json({ revisions: await service.store.history(id) });
  });
  router.post('/sessions/:sessionId/purge', async (req, res) => {
    const id = z.uuid().parse(req.params.sessionId);
    const { confirmSessionId } = z.object({ confirmSessionId: z.uuid() }).strict().parse(req.body);
    if (confirmSessionId !== id) throw new AppError(400, 'Confirm the exact session ID to permanently delete its history.', 'CONFIRMATION_REQUIRED');
    await service.store.get(id);
    await service.store.purge(id);
    service.usage.purgeMemory(id);
    logger.warn('maintenance.session.purge.completed', { sessionId: id, admin: res.locals.admin });
    res.status(204).end();
  });
  const sourceMetadata = async () => {
    const entries = await catalog.effective();
    return {
      entries, roles: SOURCE_ROLES,
      // Include known classifier verticals plus any new keys from the catalog.
      verticals: [...new Set([...SOURCE_VERTICALS, ...entries.flatMap(entry => entry.verticals)])].sort(),
    };
  };
  router.get('/sources', async (_req, res) => {
    res.json({ ...catalog.status(), ...(await sourceMetadata()) });
  });
  router.post('/sources/sync', async (_req, res) => {
    const status = await catalog.sync();
    res.json({ ...status, ...(await sourceMetadata()) });
  });
  router.use((_req, _res, next) => next(new AppError(404, 'Admin endpoint not found.')));
  return router;
}

export function summarizeUsage(events: import('./usage').UsageEvent[]) {
  const sum = (key: 'inputTokens' | 'outputTokens' | 'estimatedCostUsd') => {
    const known = events.filter(e => e[key] !== null);
    return known.length ? known.reduce((total, e) => total + e[key]!, 0) : null;
  };
  return { calls: events.length, inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), estimatedCostUsd: sum('estimatedCostUsd'), partial: events.some(e => e.inputTokens === null || e.outputTokens === null || e.estimatedCostUsd === null) };
}
