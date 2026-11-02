import { createHash } from 'node:crypto';
import {
  SourceCatalogValidationError, validateSourceCatalog, type SourceCatalogIssue, type SourceEntry,
} from '@fairbuy/core';
import { SOURCE_CATALOG_SEED } from '../../data/source-catalog';
import type { Settings } from './settings';
import { logger } from './logger';

export type CatalogSource = 'fallback' | 'github';

export interface CatalogStatus {
  source: CatalogSource;
  url: string | null;
  fetchedAt: string | null;
  version: string;
  count: number;
  error: string | null;
}

/** The narrow dependency the discovery provider needs. */
export interface SourceCatalogLoader {
  effective(): Promise<SourceEntry[]>;
}

/** Test/demo fallback when no remote catalog is configured. */
export const DEFAULT_CATALOG_LOADER: SourceCatalogLoader = {
  effective: async () => SOURCE_CATALOG_SEED,
};

export function sourceCatalogVersion(entries: SourceEntry[]): string {
  const canonical = [...entries].sort((a, b) => a.domain.localeCompare(b.domain));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 12);
}

function formatCatalogIssue(issue: SourceCatalogIssue): string {
  const location = `entries[${issue.index}]${issue.domain ? ` (${issue.domain})` : ''}${issue.path ? `.${issue.path}` : ''}`;
  return `${location}: ${issue.message}`;
}

/**
 * In-memory catalog cache. The bundled seed is available immediately; an admin
 * (or startup) sync fetches the published JSON, validates it, and swaps the
 * whole catalog atomically. A failed sync never clears the last-known-good one.
 */
export class SourceCatalogService implements SourceCatalogLoader {
  private entries: SourceEntry[];
  private source: CatalogSource = 'fallback';
  private fetchedAt: string | null = null;
  private version: string;
  private error: string | null = null;

  constructor(
    private config: Pick<Settings, 'CATALOG_URL'>,
    private fetcher: typeof fetch = fetch,
    fallback: SourceEntry[] = SOURCE_CATALOG_SEED,
  ) {
    this.entries = validateSourceCatalog(fallback);
    this.version = sourceCatalogVersion(this.entries);
  }

  async effective(): Promise<SourceEntry[]> {
    return this.entries;
  }

  status(): CatalogStatus {
    return {
      source: this.source,
      url: this.config.CATALOG_URL || null,
      fetchedAt: this.fetchedAt,
      version: this.version,
      count: this.entries.length,
      error: this.error,
    };
  }

  async sync(): Promise<CatalogStatus> {
    const value = this.config.CATALOG_URL;
    if (!value) return this.fail('No catalog URL is configured.');
    let url: URL;
    try { url = new URL(value); } catch { return this.fail('The catalog URL is invalid.', { value }); }
    if (url.protocol !== 'https:') return this.fail('The catalog URL must use HTTPS.', { url: url.toString(), protocol: url.protocol });

    const started = Date.now();
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': 'FairBuy/1.0' },
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        cache: 'no-store',
      });
    } catch (error) {
      return this.fail('The catalog host could not be reached.', {
        url: url.toString(), cause: error instanceof Error ? error.name : 'unknown',
      });
    }
    if (!response.ok) {
      await response.body?.cancel();
      return this.fail(`The catalog request failed (${response.status}).`, {
        url: url.toString(), status: response.status, contentType: response.headers.get('content-type'),
      });
    }

    let text: string;
    try { text = await response.text(); }
    catch (error) {
      return this.fail('The catalog response could not be read.', {
        url: url.toString(), cause: error instanceof Error ? error.name : 'unknown',
      });
    }
    if (text.length > 512 * 1024) {
      return this.fail('The catalog response is too large.', { url: url.toString(), bytes: text.length, limit: 512 * 1024 });
    }

    let payload: unknown;
    try { payload = JSON.parse(text); }
    catch (error) {
      return this.fail('The catalog is not valid JSON.', {
        url: url.toString(), bytes: text.length,
        parseError: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
      });
    }
    const envelope = payload as { schemaVersion?: unknown; entries?: unknown } | null;
    if (!payload || typeof payload !== 'object' || envelope?.schemaVersion !== 1 || !Array.isArray(envelope?.entries)) {
      return this.fail('The catalog must be a schemaVersion 1 envelope with an entries array.', {
        url: url.toString(),
        schemaVersion: envelope?.schemaVersion ?? null,
        entriesType: Array.isArray(envelope?.entries) ? 'array' : typeof envelope?.entries,
      });
    }

    const incoming = envelope.entries as unknown[];
    let entries: SourceEntry[];
    try { entries = validateSourceCatalog(incoming); }
    catch (error) {
      if (error instanceof SourceCatalogValidationError) {
        const issues = error.issues.slice(0, 20).map(formatCatalogIssue);
        logger.warn('source_catalog.validation.failed', {
          url: url.toString(), entries: incoming.length, issueCount: error.issues.length, issues,
        });
        const summary = error.issues.slice(0, 3).map(formatCatalogIssue).join('; ');
        return this.fail(`The catalog has ${error.issues.length} validation issue(s): ${summary}${error.issues.length > 3 ? ` (+${error.issues.length - 3} more; see logs)` : ''}`, {
          url: url.toString(), entries: incoming.length, issueCount: error.issues.length,
        });
      }
      return this.fail('The catalog entries failed validation.', {
        url: url.toString(), entries: incoming.length, cause: error instanceof Error ? error.name : 'unknown',
      });
    }
    if (!entries.length) return this.fail('The catalog has no entries.', { url: url.toString() });

    // Swap only after the whole payload is valid.
    this.entries = entries;
    this.source = 'github';
    this.fetchedAt = new Date().toISOString();
    this.version = sourceCatalogVersion(entries);
    this.error = null;
    logger.info('source_catalog.synced', {
      entries: entries.length, version: this.version, durationMs: Date.now() - started,
    });
    return this.status();
  }

  private fail(message: string, details: Record<string, unknown> = {}): CatalogStatus {
    this.error = message;
    logger.warn('source_catalog.sync.failed', { error: message, ...details });
    return this.status();
  }
}
