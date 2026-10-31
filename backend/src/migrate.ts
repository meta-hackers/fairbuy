import { PostgresStore } from './store';
import { settings } from './settings';
const config = settings();
if (!config.DATABASE_URL) throw new Error('Set DATABASE_URL before running migrations');
const store = new PostgresStore(config.DATABASE_URL);
try { await store.migrate(); console.info('Database migration complete.'); }
finally { await store.close(); }
