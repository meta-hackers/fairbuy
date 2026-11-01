import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { SourceEntrySchema, validateSourceCatalog, type SourceEntry } from '@fairbuy/core';
import { SOURCE_CATALOG_SEED } from '../../data/source-catalog';
import type { SourceCatalogRecord, SourceCatalogWrite, Store } from './store';
import { AppError } from './errors';
import { logger } from './logger';

export type CatalogOrigin = 'default' | 'modified' | 'custom';

export interface CatalogEntryView {
  entry: SourceEntry;
  origin: CatalogOrigin;
  hasDefault: boolean;
  defaultEntry?: SourceEntry;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** The narrow dependency the discovery provider needs; keeps tests store-free. */
export interface SourceCatalogLoader {
  effective(): Promise<SourceEntry[]>;
}

/** Test/demo fallback when no database-backed catalog is injected. */
export const DEFAULT_CATALOG_LOADER: SourceCatalogLoader = {
  effective: async () => SOURCE_CATALOG_SEED,
};

export type SeedMode = 'insert-missing' | 'update-defaults' | 'sync';

export interface SeedReport {
  mode: SeedMode;
  dryRun: boolean;
  seedVersion: string;
  inserted: number;
  updated: number;
  preserved: number;
  unchanged: number;
  removedDefaults: string[];
  customUntouched: number;
}

export function sourceCatalogSeedVersion(entries: SourceEntry[]): string {
  const canonical = [...entries].sort((a, b) => a.domain.localeCompare(b.domain));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 12);
}

/**
 * The database is the runtime catalog. The seed file is the reviewed baseline;
 * admin edits are rows whose entry differs from defaultEntry. A custom row has
 * no defaultEntry and is unaffected by seed updates.
 */
export class SourceCatalogService implements SourceCatalogLoader {
  constructor(private store: Store) {}

  async effective(): Promise<SourceEntry[]> {
    const records = await this.store.listSourceCatalog();
    if (!records.length) logger.warn('source_catalog.empty', {});
    return records.map(record => record.entry);
  }

  async views(): Promise<CatalogEntryView[]> {
    const records = await this.store.listSourceCatalog();
    return records.map(record => this.view(record)).sort((a, b) => a.entry.domain.localeCompare(b.entry.domain));
  }

  private view(record: SourceCatalogRecord): CatalogEntryView {
    const hasDefault = record.defaultEntry !== null;
    const origin: CatalogOrigin = !hasDefault ? 'custom'
      : isDeepStrictEqual(record.entry, record.defaultEntry) ? 'default' : 'modified';
    return {
      entry: record.entry,
      origin,
      hasDefault,
      ...(record.defaultEntry ? { defaultEntry: record.defaultEntry } : {}),
      updatedAt: record.updatedAt,
      updatedBy: record.updatedBy,
    };
  }

  async save(domain: string, value: SourceEntry, admin: string): Promise<SourceEntry> {
    const entry = SourceEntrySchema.parse(value);
    if (entry.domain !== domain) throw new AppError(400, 'The domain in the path and the catalog entry must match.', 'SOURCE_DOMAIN_MISMATCH');
    const existing = await this.store.getSourceCatalog(domain);
    const seeded = SOURCE_CATALOG_SEED.find(source => source.domain === domain);
    await this.store.upsertSourceCatalog({
      domain: entry.domain,
      entry,
      defaultEntry: existing?.defaultEntry ?? seeded ?? null,
      seedVersion: existing?.seedVersion ?? (seeded ? sourceCatalogSeedVersion(SOURCE_CATALOG_SEED) : null),
    }, admin);
    logger.info('admin.source_catalog.saved', { domain: entry.domain, admin, enabled: entry.enabled !== false });
    return entry;
  }

  /** A seeded entry reverts to its default; a custom entry is deleted. */
  async remove(domain: string, admin: string): Promise<void> {
    if (!(await this.store.getSourceCatalog(domain))) return;
    await this.store.resetSourceCatalogEntry(domain, admin);
    logger.info('admin.source_catalog.reset', { domain, admin });
  }

  async resetAll(admin: string): Promise<void> {
    await this.store.resetSourceCatalog(admin);
    logger.info('admin.source_catalog.reset_all', { admin });
  }

  async seed(entries: SourceEntry[], mode: SeedMode, actor: string, dryRun = false): Promise<SeedReport> {
    const validated = validateSourceCatalog(entries);
    const seedVersion = sourceCatalogSeedVersion(validated);
    const existing = new Map((await this.store.listSourceCatalog()).map(record => [record.domain, record]));
    const seedDomains = new Set(validated.map(entry => entry.domain));
    const report: SeedReport = {
      mode, dryRun, seedVersion, inserted: 0, updated: 0, preserved: 0, unchanged: 0,
      removedDefaults: [...existing.values()]
        .filter(record => record.defaultEntry !== null && !seedDomains.has(record.domain))
        .map(record => record.domain)
        .sort(),
      customUntouched: [...existing.values()].filter(record => record.defaultEntry === null && !seedDomains.has(record.domain)).length,
    };
    const write = async (record: SourceCatalogWrite) => {
      if (!dryRun) await this.store.upsertSourceCatalog(record, actor);
    };
    for (const entry of validated) {
      const current = existing.get(entry.domain);
      if (!current) {
        report.inserted++;
        await write({ domain: entry.domain, entry, defaultEntry: entry, seedVersion });
        continue;
      }
      if (mode === 'insert-missing') { report.unchanged++; continue; }
      if (mode === 'sync') {
        if (isDeepStrictEqual(current.entry, entry) && isDeepStrictEqual(current.defaultEntry, entry)) report.unchanged++;
        else { report.updated++; await write({ domain: entry.domain, entry, defaultEntry: entry, seedVersion }); }
        continue;
      }
      // update-defaults preserves an admin edit (or a custom value) while
      // refreshing the default snapshot behind it.
      const modified = current.defaultEntry === null || !isDeepStrictEqual(current.entry, current.defaultEntry);
      if (modified) {
        report.preserved++;
        await write({ domain: entry.domain, entry: current.entry, defaultEntry: entry, seedVersion });
      } else if (isDeepStrictEqual(current.entry, entry) && isDeepStrictEqual(current.defaultEntry, entry)) {
        report.unchanged++;
      } else {
        report.updated++;
        await write({ domain: entry.domain, entry, defaultEntry: entry, seedVersion });
      }
    }
    logger.info('source_catalog.seeded', { ...report, actor });
    return report;
  }
}
