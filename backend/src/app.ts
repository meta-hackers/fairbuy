import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ConfigSchema, CoordinatesSchema, InstantClassifierInputSchema, LearnInputSchema, MessageInputSchema, ShoppingLocationSchema } from '@fairbuy/core';
import type { Settings } from './settings';
import type { ShoppingService } from './shopping-service';
import { AppError, publicError } from './errors';
import { LocationResolver } from './location';
import { InstantClassifier } from './instant-classifier';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function equal(a: string, b: string) { return timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b))); }
function cookies(req: Request) {
  return Object.fromEntries((req.headers.cookie ?? '').split(';').map(c => c.trim().split('=')).filter(c => c.length === 2));
}
export function createApp(service: ShoppingService, config: Settings, locations = new LocationResolver(), classifier = new InstantClassifier(config)) {
  const app = express();
  app.disable('x-powered-by');
  if (config.NODE_ENV === 'production') app.set('trust proxy', 1); // Render's single edge proxy
  app.use(helmet({ contentSecurityPolicy: { directives: { 'img-src': ["'self'", 'data:'], 'connect-src': ["'self'"], 'script-src': ["'self'"], 'style-src': ["'self'", "'unsafe-inline'"], 'form-action': ["'self'"], 'frame-ancestors': ["'none'"] } } }));
  app.get(['/health', '/healthz'], async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { await service.store.health(); res.json({ status: 'ok' }); }
    catch { res.status(503).json({ status: 'unavailable' }); }
  });
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: 1800, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many requests. Please try again later.' } }));
  app.use('/api', express.json({ limit: '32kb' }));
  app.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.get('X-Fairbuy-Request') !== '1') return next(new AppError(403, 'Missing request verification header.'));
      const origin = req.get('Origin');
      const expected = config.APP_ORIGIN || config.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get('host')}`;
      const devOrigins = config.NODE_ENV !== 'production' ? ['http://localhost:5173', 'http://127.0.0.1:5173'] : [];
      if (origin && origin !== expected && !devOrigins.includes(origin)) return next(new AppError(403, 'Cross-origin requests are not allowed.'));
    }
    const cookie = cookies(req);
    let ownerToken = cookie.fairbuy_owner;
    if (!ownerToken || !/^[a-f0-9]{64}$/.test(ownerToken)) {
      ownerToken = randomBytes(32).toString('hex');
      res.cookie('fairbuy_owner', ownerToken, { httpOnly: true, secure: config.NODE_ENV === 'production', sameSite: 'lax', maxAge: 7 * 86400000, path: '/' });
    }
    res.locals.owner = hash(ownerToken);
    res.locals.access = !config.APP_ACCESS_TOKEN || equal(cookie.fairbuy_access ?? '', hash(`${config.APP_ACCESS_TOKEN}:${ownerToken}`));
    res.locals.ownerToken = ownerToken;
    next();
  });
  app.get('/api/bootstrap', async (_req, res) => {
    const latest = res.locals.access ? await service.store.latest(res.locals.owner) : null;
    res.json({
      mode: config.FAIRBUY_MODE, accessRequired: !res.locals.access,
      aiConfigured: config.FAIRBUY_MODE === 'demo' || !!config.MODEL_API_KEY,
      instantClassifierConfigured: res.locals.access && classifier.configured(),
      searchProvider: config.SEARCH_PROVIDER, persistent: !!config.DATABASE_URL,
      session: latest?.mode === config.FAIRBUY_MODE ? latest : null,
    });
  });
  app.post('/api/access', rateLimit({ windowMs: 15 * 60000, limit: 10, message: { error: 'Too many access attempts. Try again later.' } }), (req, res) => {
    const { token } = z.object({ token: z.string().min(1).max(500) }).parse(req.body);
    if (config.APP_ACCESS_TOKEN && !equal(token, config.APP_ACCESS_TOKEN)) throw new AppError(401, 'Incorrect app password.');
    res.cookie('fairbuy_access', hash(`${config.APP_ACCESS_TOKEN}:${res.locals.ownerToken}`), { httpOnly: true, secure: config.NODE_ENV === 'production', sameSite: 'lax', maxAge: 7 * 86400000, path: '/' });
    res.json({ ok: true });
  });
  app.post('/api/location/reverse', rateLimit({ windowMs: 60 * 60000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Location lookup limit reached. Please set your location manually.' } }), async (req, res) => {
    const { latitude, longitude } = CoordinatesSchema.parse(req.body);
    res.json(await locations.reverse(latitude, longitude));
  });
  app.use('/api', (_req, res, next) => res.locals.access ? next() : next(new AppError(401, 'Enter the app password to continue.', 'ACCESS_REQUIRED')));
  const classifierLimit = rateLimit({ windowMs: 60000, limit: 20, keyGenerator: (_req, res) => res.locals.owner, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Preview limit reached. You can still send your message.', code: 'CLASSIFIER_LIMIT' } });
  const classifierDailyLimit = rateLimit({ windowMs: 86400000, limit: 200, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Daily preview limit reached for this network. You can still send your message.', code: 'CLASSIFIER_LIMIT' } });
  app.post('/api/instant-classifier', classifierLimit, classifierDailyLimit, async (req, res) => {
    const { text } = InstantClassifierInputSchema.parse(req.body);
    const controller = new AbortController();
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', cancel);
    try {
      const result = await classifier.classify(res.locals.owner, text, controller.signal);
      if (!res.destroyed) res.json(result);
    } finally { res.off('close', cancel); }
  });
  const aiLimit = rateLimit({ windowMs: 60 * 60000, limit: 45, keyGenerator: (_req, res) => res.locals.owner, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'AI request limit reached. Try again in an hour.' } });
  const dailyLimit = rateLimit({ windowMs: 86400000, limit: 150, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Daily AI limit reached for this network.' } });
  app.post('/api/sessions', aiLimit, async (req, res) => {
    const { location } = z.object({ location: ShoppingLocationSchema.optional() }).strict().parse(req.body ?? {});
    res.status(201).json(await service.create(res.locals.owner, location));
  });
  app.param('id', (_req, _res, next, value) => { try { z.uuid().parse(value); next(); } catch { next(new AppError(400, 'Invalid search ID.')); } });
  app.get('/api/sessions/:id', async (req, res) => { res.json(await service.store.get(String(req.params.id), res.locals.owner)); });
  app.delete('/api/sessions/:id', async (req, res) => { await service.store.delete(String(req.params.id), res.locals.owner); res.status(204).end(); });
  app.patch('/api/sessions/:id/location', async (req, res) => {
    const { onlyIfMissing, ...location } = ShoppingLocationSchema.extend({ onlyIfMissing: z.boolean().default(false) }).parse(req.body);
    res.json(await service.locate(String(req.params.id), res.locals.owner, location, onlyIfMissing));
  });
  app.post('/api/sessions/:id/ask', dailyLimit, aiLimit, async (req, res) => {
    const { message } = MessageInputSchema.parse(req.body);
    res.json(await service.message(String(req.params.id), res.locals.owner, 'ask', message));
  });
  app.post('/api/sessions/:id/configure/chat', dailyLimit, aiLimit, async (req, res) => {
    const { message } = MessageInputSchema.parse(req.body);
    res.json(await service.message(String(req.params.id), res.locals.owner, 'configure', message));
  });
  app.put('/api/sessions/:id/configure', async (req, res) => {
    res.json(await service.configure(String(req.params.id), res.locals.owner, ConfigSchema.parse(req.body)));
  });
  app.post('/api/sessions/:id/discovery', dailyLimit, aiLimit, async (req, res) => {
    res.status(202).json(await service.discover(String(req.params.id), res.locals.owner));
  });
  app.post('/api/sessions/:id/learn', dailyLimit, aiLimit, async (req, res) => {
    res.status(202).json(await service.learn(String(req.params.id), res.locals.owner, LearnInputSchema.parse(req.body)));
  });
  app.delete('/api/sessions/:id/learn/:feedbackId', dailyLimit, aiLimit, async (req, res) => {
    res.status(202).json(await service.undo(String(req.params.id), res.locals.owner, z.uuid().parse(req.params.feedbackId)));
  });
  app.post('/api/sessions/:id/select', async (req, res) => {
    const { productId } = z.object({ productId: z.string().min(1).max(100) }).parse(req.body);
    res.json(await service.select(String(req.params.id), res.locals.owner, productId));
  });
  app.patch('/api/sessions/:id/stage', async (req, res) => {
    const { stage } = z.object({ stage: z.enum(['ask', 'configure', 'discovery', 'buy']) }).strict().parse(req.body);
    res.json(await service.navigate(String(req.params.id), res.locals.owner, stage));
  });
  app.use('/api', (_req, _res, next) => next(new AppError(404, 'API endpoint not found.')));
  const webRoot = fileURLToPath(new URL('../../frontend/dist/', import.meta.url));
  if (existsSync(webRoot)) {
    app.use(express.static(webRoot, { index: false, maxAge: '1h' }));
    app.get('/{*path}', (_req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile('index.html', { root: webRoot }); });
  }
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) { res.status(400).json({ error: 'Some input is invalid or too long. Please review it.', code: 'INVALID_INPUT' }); return; }
    const bodyError = error as { type?: string };
    if (bodyError?.type === 'entity.too.large' || bodyError?.type === 'entity.parse.failed') { res.status(400).json({ error: 'Invalid JSON or request too large.', code: 'INVALID_BODY' }); return; }
    if (!(error instanceof AppError)) console.error('Unexpected API error.');
    res.status(error instanceof AppError ? error.status : 500).json({ error: publicError(error), code: error instanceof AppError ? error.code : 'INTERNAL_ERROR' });
  });
  return app;
}
