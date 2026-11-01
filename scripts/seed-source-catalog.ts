import { validateSourceCatalog } from '@fairbuy/core';
import { SOURCE_CATALOG_SEED } from '../data/source-catalog';
import { PostgresStore } from '../backend/src/store';
import { SourceCatalogService } from '../backend/src/source-catalog';

const args = new Set(process.argv.slice(2));
if (args.has('--help') || args.has('-h')) {
  console.log(`Usage: npm run catalog:seed -- [mode] [options]

Modes:
  --insert-missing    Add new seed domains; leave existing rows untouched (default)
  --update-defaults   Refresh default snapshots; preserve admin edits and custom values
  --sync              Overwrite seeded domains with the seed file (custom rows untouched)

Options:
  --dry-run           Report the changes without writing
  --json              Print the report as JSON
  --export            Print the effective database catalog as JSON and exit`);
  process.exit(0);
}
const mode = args.has('--sync') ? 'sync' : args.has('--update-defaults') ? 'update-defaults' : 'insert-missing';
const dryRun = args.has('--dry-run');
const json = args.has('--json');
const exportOnly = args.has('--export');
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required. Set it in .env or the environment.');
  process.exit(1);
}

const entries = exportOnly ? [] : validateSourceCatalog(SOURCE_CATALOG_SEED);
const store = new PostgresStore(url);
try {
  await store.migrate();
  if (exportOnly) {
    console.log(JSON.stringify(await new SourceCatalogService(store).effective(), null, 2));
  } else {
    const report = await new SourceCatalogService(store).seed(entries, mode, 'seed-script', dryRun);
    if (json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`Source catalog seed: ${mode}${dryRun ? ' (dry run)' : ''}`);
      console.log(`  seed version:              ${report.seedVersion}`);
      console.log(`  inserted:                  ${report.inserted}`);
      console.log(`  updated:                   ${report.updated}`);
      console.log(`  preserved admin edits:     ${report.preserved}`);
      console.log(`  unchanged:                 ${report.unchanged}`);
      console.log(`  custom entries untouched:  ${report.customUntouched}`);
      if (report.removedDefaults.length) console.warn(`  removed from seed (left in DB): ${report.removedDefaults.join(', ')}`);
      if (dryRun) console.log('No database changes were written.');
    }
  }
} finally {
  await store.close();
}
