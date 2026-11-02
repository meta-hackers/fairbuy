# Category-aware source hints

## Why

A generic web search does not know that a Swiss laptop buyer should start at Digitec or Galaxus, that Open Icecat is a specification database rather than a shop, or that a food-delivery comparison needs a different unit (a basket, not a single product). Sending every category and country through one broad query costs extra searches and produces weaker sellers.

FairBuy therefore computes a small **source plan** for each discovery round and passes it to the research model as structured input. The plan is a hint, not an allowlist and not evidence.

## Source roles

| Role | Meaning | May support an offer? |
|---|---|---|
| `seller` | A shop that sells products directly | Yes: offer URL and listed price |
| `marketplace` | A marketplace or classifieds site | Yes: offer URL and listed price |
| `spec` | Datasheets and specification databases, e.g. Open Icecat | No: attribute evidence only |
| `review` | Independent tests and reviews | No: attribute/context evidence only |
| `comparison` | Price-comparison sites, e.g. Toppreise, idealo | No: model/seller discovery and context only |

`sourcePlan.nonSellerDomains` lists the hosts with no `seller`/`marketplace` role. `normalizeExtraction()` rejects an offer whose URL belongs to one of those hosts, even if the URL appears in the research sources. This is what prevents an Icecat datasheet from becoming an offer.

## Where the catalog lives

The canonical catalog is a separate public repository:

- Repository: https://github.com/meta-hackers/fairbuy-sources-catalog
- Published page: https://meta-hackers.github.io/fairbuy-sources-catalog/
- Machine-readable JSON: https://meta-hackers.github.io/fairbuy-sources-catalog/sources.json

`sources.json` uses a versioned envelope:

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-11-02T00:00:00.000Z",
  "entries": [
    {
      "domain": "galaxus.ch",
      "name": "Galaxus",
      "roles": ["seller"],
      "verticals": ["computers", "electronics", "home"],
      "countries": ["CH"],
      "priority": 3
    }
  ]
}
```

See the [catalog repository README](https://github.com/meta-hackers/fairbuy-sources-catalog) for the full schema, role guide and examples.

FairBuy stores the catalog in PostgreSQL. The canonical data still lives in the catalog repository; the application has no bundled snapshot to preload. On startup it reads the last complete sync from the database, so a restart keeps the latest catalog even before any new sync. A successful sync rewrites every stored entry in one transaction. `data/source-catalog.ts` is a test fixture only and is never loaded by the application.

## How the plan is built

1. `classifyVertical()` maps the free-form `category` and `purpose` to a vertical: `computers`, `electronics`, `food_delivery`, `fashion`, `watches`, `home`, `sports`, `books`, `auto`, or `general`. It uses multilingual keywords and light plural folding; unknown briefs stay `general`.
2. `sourcePlan()` filters the current catalog by vertical and country, sorts by priority, and returns at most:
   - 8 seller/marketplace hints,
   - 3 specification hints,
   - 4 review/comparison hints,
   - the non-seller domains for enforcement.
3. Country coverage is explicit. `ricardo.ch`, `galaxus.ch` and `digitec.ch` do not appear for an Italian brief; `mediaworld.it` does not appear for a Swiss brief. `global` entries are country-independent.
4. `enabled: false` hides an entry from hints but keeps its role for enforcement, so a disabled specification source is still never accepted as an offer URL.
5. Catalog vertical keys are **open-ended**. The app accepts any lowercase key matching `^[a-z][a-z0-9_]*$`; a new key does not fail the sync. It only influences discovery once `classifyVertical()` can produce that key, so a new vertical may need a small classifier update even though the catalog itself is already valid.

The catalog is intentionally curated rather than model-generated. A model asked to “list shops” can invent domains, and a separate seller-discovery round-trip delays the first result. The research model already has web search; it can choose additional sources freely beyond the hints.

## How the app updates

The app reads the catalog from the database and caches it in memory for discovery; discovery never fetches GitHub directly.

- **Startup load:** after migrations, the app reads the last complete catalog from PostgreSQL. This is what preserves the latest sync across restarts.
- **Admin sync:** Backoffice → **Sources** → **Sync from GitHub** calls `POST /api/admin/sources/sync`.
- **Startup sync:** with `CATALOG_SYNC_ON_START=true` (disabled by default), the app also attempts one background sync after startup. It never blocks readiness; the database catalog is already loaded.
- **Fetch rules:** HTTPS only, 10-second timeout, no redirects, 512 KB cap, `Cache-Control: no-store`.
- **Validation:** the payload must have `schemaVersion: 1` and an `entries` array; every entry must pass `SourceEntrySchema`, and duplicate domains are rejected.
- **Full replacement:** after validation, every catalog row is deleted and reinserted inside one database transaction. A sync never merges old and new entries.
- **Failure:** the last-known-good catalog stays in both the database and memory, and the admin UI shows the error. A failed sync never clears the catalog or falls back to an empty plan silently.

The Sources view shows the current entries, whether the in-memory source is `GitHub` (just synced) or `Database` (loaded from PostgreSQL), the last sync time, the version hash, the entry count and the configured URL.

## Editing the catalog

1. Edit `sources.json` in the [catalog repository](https://github.com/meta-hackers/fairbuy-sources-catalog).
2. Run `node scripts/validate.mjs` locally.
3. Open a pull request. CI validates it before merging.
4. After merge, GitHub Pages publishes the new JSON.
5. An admin opens **Backoffice → Sources → Sync from GitHub**.

The app is configured with:

- `CATALOG_URL`: the published JSON URL. Defaults to the catalog repository's Pages URL and must be HTTPS.
- `CATALOG_SYNC_ON_START`: `false` by default; set `true` to also try one background sync at startup. Admins can always trigger a sync from the backoffice. A fresh database has an empty catalog until the first successful sync.

GitHub Pages can serve a cached copy for a short time after a deploy. If a sync shows the previous version, wait for the Pages deployment and retry.

## How discovery uses it

- **Meta hosted search:** `sourcePlan` is part of the research input. `DISCOVERY_PROMPT` explains how to use it but never hardcodes site names.
- **Brave:** the broad query remains the coverage guarantee. When the vertical is known and the plan has sellers, up to three rotating `site:` domains are added per pass, so all eight planned sellers are eventually searched instead of only the first four. Calls are serialized with `BRAVE_MIN_INTERVAL_MS` because Brave plans are rate-limited per second, and a failed seller query does not discard the broad result. Each query is recorded as a separate usage event.
- **Extraction:** `EXTRACT_PROMPT` forbids using a non-seller domain as an offer URL or price source. `normalizeExtraction()` enforces the same rule mechanically.
- **Logs:** discovery start/pass logs include `vertical`, `plannedSellers` and `plannedSpecs`. Use them to check whether the plan is actually helping.

## Food delivery

Uber Eats, Glovo, Deliveroo, Just Eat and similar platforms are listed for `food_delivery`, but they are not ordinary product sellers:

- menus and prices depend on the restaurant **and the delivery address**;
- delivery fees, service fees, minimum order and promotions are material;
- pages are often JavaScript-rendered and may not expose a grounded item price to snippet search.

The current offer contract compares the seller’s final listed item price and intentionally excludes delivery/fees. The prompt therefore requires the same basket, location and currency before comparing food-delivery prices, and otherwise asks for the missing information to be disclosed. A full food vertical would need a basket-based contract (`items`, `deliveryFee`, `serviceFee`, `minimumOrder`, promotion) rather than source hints alone.

## Safety and limits

- The catalog page is public but read-only. The app validates every payload and never executes its content.
- The sync URL must use HTTPS, rejects redirects, has a timeout and a response-size cap, and validates every entry before swapping.
- Anyone with write access to the catalog repository can change the catalog. Pull-request review and CI validation are the safeguards; for stricter production use, sign the JSON or pin a commit.
- The database catalog can be stale until the next sync, but it is the only source of truth at runtime. There is no bundled fallback.
- Curated coverage is finite. The broad query remains the fallback when the plan is empty or wrong.
- A listed seller is not a trusted or verified seller. Source hints do not change the deterministic ranking, which remains preference- and evidence-based.
- Country filtering is approximate: cross-border shopping, shipping availability and local-language pages can still surface a source that the filter excluded.
- The in-memory cache is per process. A restart reloads the persisted catalog from PostgreSQL; it does not need a new GitHub sync.
