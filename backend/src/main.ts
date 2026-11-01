import { settings } from './settings';
import { MemoryStore, PostgresStore } from './store';
import { DemoAIProvider } from './ai/demo';
import { LiveAIProvider } from './ai/provider';
import { ShoppingService } from './shopping-service';
import { createApp } from './app';
import { startWorker } from './worker';
import { UsageStore } from './usage';
import { logger } from './logger';

const config = settings();
if (!config.DATABASE_URL && config.FAIRBUY_MODE !== 'demo') throw new Error('Live mode requires DATABASE_URL. Use FAIRBUY_MODE=demo for an explicitly synthetic, ephemeral preview.');
const store = config.DATABASE_URL ? new PostgresStore(config.DATABASE_URL) : new MemoryStore();
// Readiness gate: /healthz (liveness) passes as soon as we listen; /health
// (readiness) passes only after migrations succeed.
let ready = !(store instanceof PostgresStore);
const ai = config.FAIRBUY_MODE === 'demo' ? new DemoAIProvider() : new LiveAIProvider(config);
const service = new ShoppingService(store, ai, config.FAIRBUY_MODE, new UsageStore(store instanceof PostgresStore ? store.pool : undefined), config);
const app = createApp(service, config, undefined, undefined, () => ready);
// config.PORT is the validated numeric equivalent of process.env.PORT || 4000.
// Render requires binding the public HTTP server to all interfaces.
const server = app.listen(config.PORT, '0.0.0.0', () => { console.info(`FairBuy listening on port ${config.PORT} (${config.FAIRBUY_MODE}).`); });

async function migrateWithRetry(attempts = 12) {
  if (!(store instanceof PostgresStore)) return;
  for (let attempt = 1; ; attempt++) {
    try { await store.migrate(); ready = true; logger.info('database.ready', {}); return; }
    catch (error) {
      logger.error('database.migration.retrying', { attempt, error: error instanceof Error ? error.name : 'unknown' });
      if (attempt >= attempts) { logger.error('database.migration.failed', { attempts }); throw error; }
      await new Promise(resolve => setTimeout(resolve, Math.min(5000 * attempt, 30000)));
    }
  }
}
const migrated = void migrateWithRetry();
const stopWorker = startWorker(service, () => ready);
// Render allows ~30s for graceful shutdown; force-exit well inside that budget.
let closing = false;
async function shutdown(signal: string) {
  if (closing) return; closing = true;
  logger.info('server.shutdown.started', { signal });
  const deadline = setTimeout(() => process.exit(1), 20000); deadline.unref();
  try {
    await Promise.race([
      new Promise<void>(resolve => server.close(() => resolve())),
      new Promise<void>(resolve => setTimeout(resolve, 10000)),
    ]);
    await Promise.race([Promise.allSettled([stopWorker(), store.close()]), new Promise(resolve => setTimeout(resolve, 8000))]);
    logger.info('server.shutdown.completed', { signal });
  } finally { clearTimeout(deadline); process.exit(0); }
}
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('unhandledRejection', reason => {
  logger.error('process.unhandled_rejection', { error: reason instanceof Error ? reason.name : 'unknown' });
  void shutdown('unhandledRejection');
});
await migrated;
