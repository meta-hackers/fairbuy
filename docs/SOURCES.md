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

## How the plan is built

The seed data lives outside application logic in `data/source-catalog.ts`. The
database `source_catalog` table is the runtime source of truth:

1. The seed script, or the startup `insert-missing` pass, loads `SOURCE_CATALOG_SEED` into `source_catalog`.
2. `classifyVertical()` maps the free-form `category` and `purpose` to a vertical: `computers`, `electronics`, `food_delivery`, `fashion`, `home`, `sports`, `books`, `auto`, or `general`. It uses multilingual keywords and light plural folding; unknown briefs stay `general`.
3. `sourcePlan()` filters the database entries by vertical and country, sorts by priority, and returns at most:
   - 8 seller/marketplace hints,
   - 3 specification hints,
   - 4 review/comparison hints,
   - the non-seller domains for enforcement.
4. Country coverage is explicit. `ricardo.ch`, `galaxus.ch` and `digitec.ch` do not appear for an Italian brief; `mediaworld.it` does not appear for a Swiss brief. `global` entries are country-independent.

Each database row has an effective `entry` and a `default_entry`. A row is
`default` when both are equal, `modified` when the admin changed the effective
entry, and `custom` when it has no seeded default. `enabled: false` hides an
entry from hints without losing its role for enforcement.

The catalog is intentionally curated rather than model-generated. A model asked
to “list shops” can invent domains, and a separate seller-discovery round-trip
delays the first result. The research model already has web search; it can
choose additional sources freely beyond the hints.

Admins can view and edit the effective catalog under **Sources** in the
[backoffice](BACKOFFICE.md#discovery-source-catalog). Changes apply to the next
discovery round.

## Seeding and maintenance

The seed file is the reviewed baseline. The database is what discovery reads.

```sh
# Safe default: add new seed domains, leave existing rows untouched
npm run catalog:seed

# Refresh default snapshots while preserving admin edits and custom entries
npm run catalog:seed -- --update-defaults

# Preview any mode without writing
npm run catalog:seed -- --update-defaults --dry-run

# Deliberate overwrite of seeded domains; custom entries remain
npm run catalog:seed -- --sync

# Print the effective database catalog as JSON (for review or AI merges)
npm run catalog:export
```

In a production build, use the compiled script so it does not depend on the
`tsx` dev dependency:

```sh
npm run catalog:seed:dist -- --update-defaults --dry-run
```

The script validates every entry with `SourceEntrySchema`, rejects duplicate
domains, runs in a transaction and reports inserted, updated, preserved and
removed defaults. A domain removed from the seed file is reported but left in
the database; remove it in the backoffice if that is deliberate.

The AI workflow is: edit `data/source-catalog.ts`, run
`npm run catalog:seed -- --update-defaults --dry-run`, then run it without
`--dry-run`. Both the file and the database stay aligned. If someone edits the
catalog in the backoffice instead, `npm run catalog:export` returns the
effective database entries to merge back into the seed file.

On startup, the app runs `insert-missing` after migrations, so a new environment
gets the seed catalog without a manual step. It never overwrites existing rows.
In memory mode (demo/local without PostgreSQL), the same seed runs before the
server starts and is ephemeral.

## How discovery uses it

- **Meta hosted search:** `sourcePlan` is part of the research input. `DISCOVERY_PROMPT` explains how to use it but never hardcodes site names.
- **Brave:** the broad query is unchanged, preserving coverage and `best_available` behavior. When the vertical is known and the plan has sellers, a second targeted query adds up to four `site:` domains. Both queries run in parallel, and a failed targeted query does not discard the broad result. This uses one extra search request per pass in Brave mode and is recorded as a separate usage event; the broad query remains the coverage guarantee.
- **Extraction:** `EXTRACT_PROMPT` forbids using a non-seller domain as an offer URL or price source. `normalizeExtraction()` enforces the same rule mechanically.
- **Logs:** discovery start/pass logs include `vertical`, `plannedSellers` and `plannedSpecs`. Use them to check whether the plan is actually helping.

## Food delivery

Uber Eats, Glovo, Deliveroo, Just Eat and similar platforms are listed for `food_delivery`, but they are not ordinary product sellers:

- menus and prices depend on the restaurant **and the delivery address**;
- delivery fees, service fees, minimum order and promotions are material;
- pages are often JavaScript-rendered and may not expose a grounded item price to snippet search.

The current offer contract compares the seller’s final listed item price and intentionally excludes delivery/fees. The prompt therefore requires the same basket, location and currency before comparing food-delivery prices, and otherwise asks for the missing information to be disclosed. A full food vertical would need a basket-based contract (`items`, `deliveryFee`, `serviceFee`, `minimumOrder`, promotion) rather than source hints alone.

## Adding or changing a source

For the reviewed baseline, edit `data/source-catalog.ts`:

```ts
entry('example.ch', 'Example', 'seller', ['computers', 'electronics'], ['CH'], 2),
```

Then run `npm run catalog:seed -- --update-defaults`. The script validates the
whole file before writing; a bad entry aborts the import.

- Choose the narrowest correct `verticals`; use `PRODUCT_VERTICALS` only for genuinely multi-category shops.
- Use explicit `countries`. `global` is for sources that are genuinely country-independent.
- Priority `3` is a strong default for the category/country, `2` secondary, `1` occasional.
- Add `note` for role constraints, e.g. “not a shop”.
- Update `packages/core/src/sources.test.ts` when the seed changes the plan's expected output.

For an operational change without touching the seed file, use the backoffice
**Sources** view. It writes rows directly to `source_catalog`, supports custom
domains, and can disable a seeded entry or restore it to its default. Run
`npm run catalog:export` if you want to merge those runtime edits back into the
seed file. The same `SourceEntrySchema` validates seed input, the admin API and
the seed script.

## Limits

- Curated coverage is finite. The broad query remains the fallback when the plan is empty or wrong.
- A listed seller is not a trusted or verified seller. Source hints do not change the deterministic ranking, which remains preference- and evidence-based.
- The plan does not verify prices, stock or compatibility. Only returned sources and literal evidence do that.
- Country filtering is approximate: cross-border shopping, shipping availability and local-language pages can still surface a source that the filter excluded.
- The seed file and the database can drift if runtime edits are not exported and merged back. Startup uses `insert-missing`, never a destructive overwrite.
- Without PostgreSQL (demo/local memory mode), the seed catalog is ephemeral and disappears on restart.
- A disabled entry still counts for role enforcement: disabling a specification or review source does not make it an acceptable offer URL.
