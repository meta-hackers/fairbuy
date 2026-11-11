import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ClientEventSchema, ConfigSchema, CoordinatesSchema, InstantClassifierInputSchema, LearnInputSchema, MessageInputSchema, ShoppingLocationSchema, withCurrentRankings, type DiagnosticScope } from '@fairbuy/core';
import type { Settings } from './settings';
import type { ShoppingService } from './shopping-service';
import { AppError, publicError } from './errors';
import { LocationResolver } from './location';
import { InstantClassifier } from './instant-classifier';
import { logger } from './logger';
import { adminRouter } from './admin';
import type { SourceCatalogService } from './source-catalog';
import { safeUrl } from './links';
import { getPublicImage, type PublicImage } from './image-proxy';
import { ProductImageResolver } from './product-image-resolver';
import { recordDiagnostic } from './diagnostics';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function equal(a: string, b: string) { return timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b))); }
function cookies(req: Request) {
  return Object.fromEntries((req.headers.cookie ?? '').split(';').map(c => c.trim().split('=')).filter(c => c.length === 2));
}
export function createApp(service: ShoppingService, config: Settings, locations = new LocationResolver(), classifier = new InstantClassifier(config), isReady: () => boolean = () => true, catalog?: SourceCatalogService) {
  const app = express();
  const productImages = new ProductImageResolver();
  const sendImage = async (res: Response, scope: DiagnosticScope, load: () => Promise<PublicImage | null>, maxAge: number, errorsOnly = false) => {
    res.locals.traceId = scope.traceId;
    res.setHeader('X-Trace-Id', scope.traceId);
    return service.diagnostics.capture(scope, async () => {
      const started = Date.now();
      const operation = errorsOnly ? 'proxy' : 'recovery';
      recordDiagnostic('image.request.started', 'info', { operation });
      try {
        const image = await load();
        if (!image) throw new AppError(404, 'Image not available.', 'IMAGE_UNAVAILABLE');
        recordDiagnostic('image.request.completed', 'info', { operation, available: true, status: 200, durationMs: Date.now() - started });
        res.setHeader('Content-Type', image.contentType);
        res.setHeader('Content-Length', String(image.body.length));
        res.setHeader('Cache-Control', `private, max-age=${maxAge}`);
        res.send(image.body);
      } catch (error) {
        recordDiagnostic('image.request.completed', error instanceof AppError ? 'warn' : 'error', {
          operation, available: false, status: error instanceof AppError ? error.status : 500,
          reason: error instanceof AppError ? 'unavailable' : 'unexpected', durationMs: Date.now() - started,
        });
        throw error;
      }
    }, errorsOnly);
  };
  app.disable('x-powered-by');
  if (config.NODE_ENV === 'production') app.set('trust proxy', 1); // Render's single edge proxy
  // HTTP development/preview hosts must not upgrade assets to a nonexistent TLS server.
  app.use(helmet({ strictTransportSecurity: config.NODE_ENV === 'production' ? undefined : false,
    contentSecurityPolicy: { directives: { 'upgrade-insecure-requests': config.NODE_ENV === 'production' ? [] : null, 'img-src': ["'self'", 'data:'], 'connect-src': ["'self'"], 'script-src': ["'self'"], 'style-src': ["'self'", "'unsafe-inline'"], 'form-action': ["'self'"], 'frame-ancestors': ["'none'"] } } }));
  app.get('/healthz', (_req, res) => {
    // Liveness: the process is running and serving HTTP. Never touches the DB
    // so Render does not kill a cold-starting instance during migration.
    res.setHeader('Cache-Control', 'no-store');
    res.json({ status: 'ok' });
  });
  app.get('/health', async (_req, res) => {
    // Readiness: migrated schema + reachable DB.
    res.setHeader('Cache-Control', 'no-store');
    if (!isReady()) { res.status(503).json({ status: 'unavailable' }); return; }
    try { await service.store.health(); res.json({ status: 'ok' }); }
    catch { res.status(503).json({ status: 'unavailable' }); }
  });
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const started = Date.now();
    res.on('finish', () => logger.info('http.write', { method: req.method, path: req.path, status: res.statusCode, durationMs: Date.now() - started }));
    next();
  });
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
  app.use('/api/admin', adminRouter(service, config, catalog));
  app.get('/api/bootstrap', async (_req, res) => {
    const latest = res.locals.access ? await service.store.latest(res.locals.owner) : null;
    res.json({
      mode: config.FAIRBUY_MODE, accessRequired: !res.locals.access,
      aiConfigured: config.FAIRBUY_MODE === 'demo' || !!config.MODEL_API_KEY,
      instantClassifierConfigured: res.locals.access && classifier.configured(),
      searchProvider: config.SEARCH_PROVIDER, persistent: !!config.DATABASE_URL,
      session: latest?.mode === config.FAIRBUY_MODE ? withCurrentRankings(latest) : null,
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
      const latest = await service.store.latest(res.locals.owner);
      const classify = () => classifier.classify(res.locals.owner, text, controller.signal);
      const result = latest ? await service.usage.capture(latest.id, 'preview', null, classify) : await classify();
      if (!res.destroyed) res.json(result);
    } finally { res.off('close', cancel); }
  });
  const aiLimit = rateLimit({ windowMs: 60 * 60000, limit: 45, keyGenerator: (_req, res) => res.locals.owner, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'AI request limit reached. Try again in an hour.' } });
  const dailyLimit = rateLimit({ windowMs: 86400000, limit: 150, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Daily AI limit reached for this network.' } });
  app.post('/api/sessions', aiLimit, async (req, res) => {
    const { location } = z.object({ location: ShoppingLocationSchema.optional() }).strict().parse(req.body ?? {});
    res.status(201).json(withCurrentRankings(await service.create(res.locals.owner, location)));
  });
  app.param('id', (_req, _res, next, value) => { try { z.uuid().parse(value); next(); } catch { next(new AppError(400, 'Invalid search ID.')); } });
  app.get('/api/sessions/:id', async (req, res) => { res.json(withCurrentRankings(await service.store.get(String(req.params.id), res.locals.owner))); });
  app.get('/api/sessions/:id/products/:productId/image', async (req, res) => {
    const productId = z.string().min(1).max(100).parse(req.params.productId);
    const traceId = z.uuid().optional().parse(req.query.traceId) ?? randomUUID();
    // Read URLs from an owned search, never from arbitrary recovery query params.
    const session = await service.store.get(String(req.params.id), res.locals.owner);
    const round = session.rounds.slice().reverse().find(r => r.products.some(p => p.id === productId));
    const product = round?.products.find(p => p.id === productId);
    if (!product) throw new AppError(404, 'Product not found.');
    await sendImage(res, { traceId, source: 'server', sessionId: session.id, roundId: round!.id, productId }, () => productImages.get(product), 3600);
  });
  app.post('/api/client-events', rateLimit({ windowMs: 60000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false }), async (req, res) => {
    // Intentionally no free-form messages, stack traces, URLs, or console output:
    // those can contain chat text, credentials, or third-party query parameters.
    const event = ClientEventSchema.parse(req.body);
    const traceId = event.traceId ?? randomUUID();
    if (event.kind === 'image_unavailable') {
      const session = await service.store.get(event.sessionId, res.locals.owner);
      const round = session.rounds.slice().reverse().find(r => r.products.some(p => p.id === event.productId));
      if (!round) throw new AppError(404, 'Product not found.');
      service.diagnostics.record({ traceId, source: 'browser', sessionId: session.id, roundId: round.id, productId: event.productId,
        event: 'client.image_unavailable', level: 'error', details: {} });
    } else {
      const { kind, traceId: _trace, sessionId, ...details } = event;
      const session = sessionId ? await service.store.get(sessionId, res.locals.owner) : null;
      service.diagnostics.record({ traceId, source: 'browser', sessionId: session?.id ?? null, roundId: session?.rounds.at(-1)?.id ?? null, productId: null,
        event: kind === 'runtime_error' ? 'client.runtime_error' : 'client.unhandled_rejection', level: 'error', details });
    }
    logger.warn('client.error', { ...event, traceId });
    res.setHeader('X-Trace-Id', traceId);
    res.status(204).end();
  });
  // Backward-compatible route: closing a search appends an archive revision. Only
  // authenticated backoffice maintenance can physically purge its history.
  app.delete('/api/sessions/:id', async (req, res) => { await service.store.archive(String(req.params.id), res.locals.owner); res.status(204).end(); });
  app.patch('/api/sessions/:id/location', async (req, res) => {
    const { onlyIfMissing, ...location } = ShoppingLocationSchema.extend({ onlyIfMissing: z.boolean().default(false) }).parse(req.body);
    res.json(withCurrentRankings(await service.locate(String(req.params.id), res.locals.owner, location, onlyIfMissing)));
  });
  app.post('/api/sessions/:id/ask', dailyLimit, aiLimit, async (req, res) => {
    const { message } = MessageInputSchema.parse(req.body);
    res.json(withCurrentRankings(await service.message(String(req.params.id), res.locals.owner, 'ask', message)));
  });
  app.post('/api/sessions/:id/configure/chat', dailyLimit, aiLimit, async (req, res) => {
    const { message } = MessageInputSchema.parse(req.body);
    res.json(withCurrentRankings(await service.message(String(req.params.id), res.locals.owner, 'configure', message)));
  });
  app.put('/api/sessions/:id/configure', async (req, res) => {
    res.json(withCurrentRankings(await service.configure(String(req.params.id), res.locals.owner, ConfigSchema.parse(req.body))));
  });
  app.post('/api/sessions/:id/discovery', dailyLimit, aiLimit, async (req, res) => {
    res.status(202).json(withCurrentRankings(await service.discover(String(req.params.id), res.locals.owner)));
  });
  app.post('/api/sessions/:id/learn', dailyLimit, aiLimit, async (req, res) => {
    res.status(202).json(withCurrentRankings(await service.learn(String(req.params.id), res.locals.owner, LearnInputSchema.parse(req.body))));
  });
  app.delete('/api/sessions/:id/learn/:feedbackId', dailyLimit, aiLimit, async (req, res) => {
    res.status(202).json(withCurrentRankings(await service.undo(String(req.params.id), res.locals.owner, z.uuid().parse(req.params.feedbackId))));
  });
  app.post('/api/sessions/:id/select', async (req, res) => {
    const { productId } = z.object({ productId: z.string().min(1).max(100) }).parse(req.body);
    res.json(withCurrentRankings(await service.select(String(req.params.id), res.locals.owner, productId)));
  });
  app.post('/api/sessions/:id/sellers', dailyLimit, aiLimit, async (req, res) => {
    const { productId } = z.object({ productId: z.string().min(1).max(100) }).strict().parse(req.body);
    res.status(202).json(withCurrentRankings(await service.findSellers(String(req.params.id), res.locals.owner, productId)));
  });
  app.post('/api/sessions/:id/missing', async (req, res) => {
    const { query } = z.object({ query: z.string().trim().min(2).max(120) }).strict().parse(req.body);
    res.json(withCurrentRankings(await service.explainMissing(String(req.params.id), res.locals.owner, query)));
  });
  app.patch('/api/sessions/:id/stage', async (req, res) => {
    const { stage } = z.object({ stage: z.enum(['ask', 'configure', 'discovery', 'buy']) }).strict().parse(req.body);
    res.json(withCurrentRankings(await service.navigate(String(req.params.id), res.locals.owner, stage)));
  });
  // Same-origin image proxy: seller CDNs often reject direct embedding or
  // request-dependent referrers. The backend validates public HTTPS targets,
  // pins DNS, limits redirects/type/size and caches the result.
  app.get('/api/image', async (req, res) => {
    const { url, traceId: suppliedTrace, sessionId, productId } = z.object({
      url: z.string().max(2000), traceId: z.uuid().optional(), sessionId: z.uuid().optional(),
      productId: z.string().min(1).max(100).regex(/^[\w-]+$/).optional(),
    }).strict().refine(value => !!value.sessionId === !!value.productId).parse(req.query);
    if (!safeUrl(url)) throw new AppError(400, 'Invalid image URL.');
    let roundId: string | null = null;
    if (sessionId) {
      const session = await service.store.get(sessionId, res.locals.owner);
      const round = session.rounds.slice().reverse().find(r => r.products.some(p => p.id === productId && p.imageUrl === url));
      if (!round) throw new AppError(404, 'Product image not found.');
      roundId = round.id;
    }
    await sendImage(res, { traceId: suppliedTrace ?? randomUUID(), source: 'server', sessionId: sessionId ?? null, roundId, productId: productId ?? null },
      () => getPublicImage(url), 86400, true);
  });
  app.use('/api', (_req, _res, next) => next(new AppError(404, 'API endpoint not found.')));
  const backofficeRoot = fileURLToPath(new URL('../../backoffice/', import.meta.url));
  app.get(/^\/backoffice$/, (_req, res) => { res.redirect('/backoffice/'); });
  app.use('/backoffice', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); }, express.static(backofficeRoot, { maxAge: 0, dotfiles: 'deny' }));
  app.use('/backoffice', (_req, _res, next) => next(new AppError(404, 'Backoffice resource not found.')));
  const webRoot = fileURLToPath(new URL('../../frontend/dist/', import.meta.url));
  if (existsSync(webRoot)) {
    app.use(express.static(webRoot, { index: false, maxAge: '1h' }));
    app.get('/{*path}', (_req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile('index.html', { root: webRoot }); });
  }
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) { res.status(400).json({ error: 'Some input is invalid or too long. Please review it.', code: 'INVALID_INPUT' }); return; }
    const bodyError = error as { type?: string };
    if (bodyError?.type === 'entity.too.large' || bodyError?.type === 'entity.parse.failed') { res.status(400).json({ error: 'Invalid JSON or request too large.', code: 'INVALID_BODY' }); return; }
    if (!(error instanceof AppError)) logger.error('http.request.unexpected', { path: _req.path, name: error instanceof Error ? error.name : 'unknown' });
    res.status(error instanceof AppError ? error.status : 500).json({ error: publicError(error), code: error instanceof AppError ? error.code : 'INTERNAL_ERROR', ...(res.locals.traceId ? { traceId: res.locals.traceId } : {}) });
  });
  return app;
}
