import { DEFAULT_SOURCE_CATALOG, SourceEntrySchema, mergeSourceCatalog, type SourceEntry } from '@fairbuy/core';
import type { SourceOverrideRecord, Store } from './store';
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

export const DEFAULT_CATALOG_LOADER: SourceCatalogLoader = {
  effective: async () => DEFAULT_SOURCE_CATALOG,
};

/**
 * Effective catalog = built-in entries plus persisted overrides. Overrides are
 * full entries, so an admin can also hide a built-in source with enabled=false.
 */
export class SourceCatalogService implements SourceCatalogLoader {
  constructor(private store: Store) {}

  private async overrides(): Promise<SourceOverrideRecord[]> {
    const records = await this.store.listSourceOverrides();
    return records.flatMap(record => {
      const parsed = SourceEntrySchema.safeParse(record.entry);
      if (!parsed.success || parsed.data.domain !== record.domain) {
        logger.error('source_catalog.override.invalid', { domain: record.domain });
        return [];
      }
      return [{ ...record, entry: parsed.data }];
    });
  }

  async effective(): Promise<SourceEntry[]> {
    const overrides = await this.overrides();
    return mergeSourceCatalog(DEFAULT_SOURCE_CATALOG, overrides.map(record => record.entry));
  }

  async views(): Promise<CatalogEntryView[]> {
    const overrides = new Map((await this.overrides()).map(record => [record.domain, record]));
    const defaults = new Map(DEFAULT_SOURCE_CATALOG.map(source => [source.domain, source]));
    return [...new Set([...defaults.keys(), ...overrides.keys()])].sort().map(domain => {
      const base = defaults.get(domain);
      const override = overrides.get(domain);
      const entry = override?.entry ?? base!;
      return {
        entry: structuredClone(entry),
        origin: override ? (base ? 'modified' : 'custom') : 'default',
        hasDefault: !!base,
        ...(base && override ? { defaultEntry: structuredClone(base) } : {}),
        updatedAt: override?.updatedAt ?? null,
        updatedBy: override?.updatedBy ?? null,
      };
    });
  }

  async save(domain: string, value: SourceEntry, admin: string): Promise<SourceEntry> {
    const entry = SourceEntrySchema.parse(value);
    if (entry.domain !== domain) throw new AppError(400, 'The domain in the path and the catalog entry must match.', 'SOURCE_DOMAIN_MISMATCH');
    await this.store.saveSourceOverride(entry.domain, entry, admin);
    logger.info('admin.source_catalog.saved', { domain: entry.domain, admin, enabled: entry.enabled !== false });
    return entry;
  }

  /** Removes the override: a built-in entry reverts to its default, a custom entry disappears. */
  async remove(domain: string, admin: string): Promise<void> {
    await this.store.deleteSourceOverride(domain);
    logger.info('admin.source_catalog.reset', { domain, admin });
  }

  async resetAll(admin: string): Promise<void> {
    await this.store.resetSourceCatalog();
    logger.info('admin.source_catalog.reset_all', { admin });
  }
}
