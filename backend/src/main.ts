import { settings } from './settings';
import { MemoryStore, PostgresStore } from './store';
import { DemoAIProvider } from './ai/demo';
import { LiveAIProvider } from './ai/provider';
import { ShoppingService } from './shopping-service';
import { createApp } from './app';
import { startWorker } from './worker';
import { UsageStore } from './usage';

const config = settings();
if (!config.DATABASE_URL && config.FAIRBUY_MODE !== 'demo') throw new Error('Live mode requires DATABASE_URL. Use FAIRBUY_MODE=demo for an explicitly synthetic, ephemeral preview.');
const store = config.DATABASE_URL ? new PostgresStore(config.DATABASE_URL) : new MemoryStore();
if (store instanceof PostgresStore) await store.migrate();
const ai = config.FAIRBUY_MODE === 'demo' ? new DemoAIProvider() : new LiveAIProvider(config);
const service = new ShoppingService(store, ai, config.FAIRBUY_MODE, new UsageStore(store instanceof PostgresStore ? store.pool : undefined), config);
const app = createApp(service, config);
// config.PORT is the validated numeric equivalent of process.env.PORT || 4000.
// Render requires binding the public HTTP server to all interfaces.
const server = app.listen(config.PORT, '0.0.0.0', () => { console.info(`FairBuy listening on port ${config.PORT} (${config.FAIRBUY_MODE}).`); });
const stopWorker = startWorker(service);
let closing = false;
async function shutdown() {
  if (closing) return; closing = true;
  const deadline = setTimeout(() => process.exit(1), 250000); deadline.unref();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await stopWorker(); await store.close(); clearTimeout(deadline);
}
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
