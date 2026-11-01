# Developer TODOs

This is a maintainer follow-up list, not a promise that an item is already implemented. Keep it focused on engineering work; product proposal ideas and operational checks are documented separately. Remove items when completed and validated.

## Short term

- [ ] Review and refine the UI to make it more visually appealing.
- [ ] Improve discovery result relevance and overall quality.
- [ ] Investigate and fix product images that do not consistently load.
- [x] Add category- and country-aware source hints for discovery. See [source hints](SOURCES.md).
- [ ] Add user login via a one-time code sent by email.
- [ ] Limit each authenticated user to two searches per day; define how Discovery, Learn-triggered searches and retries count toward the allowance.

## Reliability and operations

- [ ] Replace process-local rate limits, classifier cache/call counters, and concurrency controls with shared storage before running more than one application instance. Add multi-instance tests.
- [ ] Add operational monitoring and alerts for database health, queue age/lease recovery, provider failures, rate-limit saturation, and usage/cost estimates.
- [ ] Document and test a routine PostgreSQL backup-restore procedure, including verification after restore and schema migration.
- [ ] Establish a supported upgrade/migration workflow for populated databases; add versioned migrations before the next incompatible schema change.
- [ ] Verify Render/Supabase/provider settings and model access periodically; keep environment-specific IDs and pricing out of durable product documentation where they can go stale.

## Product and data quality

- [ ] Evaluate live discovery quality against a maintained, privacy-safe test set, including stale snippets, ambiguous models, unsupported claims, currency mismatches, and low-coverage searches.
- [ ] Review whether normalized product identity/grouping is robust enough to prevent renamed or variant products from evading prior-product exclusions.
- [ ] Reassess source freshness and seller/offer quality indicators; provenance checks alone do not independently verify a claim.
- [ ] Add usability/accessibility review for keyboard and screen-reader workflows across Ask, Configure, progressive Discovery, Learn/Undo, and Buy.
- [ ] Review the indefinite append-only retention policy and maintenance cadence against privacy requirements, provider retention and infrastructure backups; monitor snapshot storage growth.

## Backoffice and usage accounting

- [ ] Validate recorded provider token usage and estimated costs against provider billing records; clearly communicate missing usage and excluded search/tool charges.
- [ ] Separate read-only backoffice access from maintenance permissions, and review durable audit/export/redaction controls before adding more administrators. Confirmed purge currently logs the operator and session ID.
- [ ] Add coverage for account/password rotation and admin-session revocation through a production-like configuration test.

## Documentation maintenance

- [ ] Recheck README and deployment claims after infrastructure, provider, model, or pricing changes.
- [ ] Add automated checks for local Markdown links and anchor targets so documentation navigation stays valid.
- [ ] Keep API and deployment docs aligned with route contracts, environment variables, retention limits, and Blueprint configuration.
