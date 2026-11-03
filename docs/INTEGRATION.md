# Demo integration notes

Sources inspected for this implementation:

- [`meta-hackers/fairbuy-alberto-demo`](https://github.com/meta-hackers/fairbuy-alberto-demo): local working prototype with the focused shopping flow, editable soft requirements, progressively revealed fixtures, Learn/Undo and seller options.
- [`meta-hackers/fairbuy-alessandro-demo`](https://github.com/meta-hackers/fairbuy-alessandro-demo), main commit `018a29447fa297fa77f977be9a0f5e35739d222a`: shared Zod contracts, evidence fields, typed constraint evaluation, delivered totals, deterministic ranking, backend and frontend skeletons.
- [`meta-hackers/fairbuy`](https://github.com/meta-hackers/fairbuy), base main commit `33954371a3dc7130f22a4fd454b4d6a69d803d17`: product proposal and planned architecture.

This is a consolidation, not two demos embedded behind a switch. There is one frontend flow, one shared contract and one server-owned shopping state. The proposal is retained unchanged; README and Architecture now describe implemented behavior rather than future Supabase/Meta/NestJS plans.

## Retained and adapted

| Source | Consolidated behavior |
|---|---|
| Alberto’s UX | Minimal navigation; conversation first; editable Configure; reasons/trade-offs; Learn as a dialog; feedback history/Undo; selected-product Buy. |
| Alberto’s transparency | No automatic checkout, honest synthetic preview, explicit missing charges and no fake seller purchase links. |
| Alessandro’s contract | Zod schemas for evidence, field statuses, generic attributes, offer price components and hard/soft constraints. |
| Alessandro’s ranking | Deterministic filtering before ranking, unknown checks, reproducibility and auditable score components. Cost weighting changed/documented and incomplete costs no longer receive a cheapest-price reward. |

## Replaced, intentionally

- Keyword-based Ask, fixed follow-up counts and category hardcoding → real server-side AI conversations and model-assessed readiness with required server checks.
- Fixture timers → durable research jobs and status polling; no simulated search progress in live mode.
- In-memory production state → PostgreSQL owner isolation, immutable discovery snapshots and recoverable jobs.
- Manual/local comparison-source selector → default live Meta hosted web search, optional server-configured Brave, separate explicit deployment preview mode.
- Client-calculated recommendations → one backend ranking engine; no competing browser and server truth.
- Repeated demo data for different categories → a generic, source-grounded live product schema; only the offline preview remains laptop-specific.

## Verification boundaries

Automated coverage includes ranking/unknown costs/currency/unit handling; AI REST payloads, strict-output failures and citations; source/evidence rejection; owner isolation/CSRF/access gate/input limits; full feedback-context restart and Undo; PostgreSQL persistence, row locking, exclusive job leases, recovery and deletion; desktop/320/390 px browser flows. Provider tests mock HTTP and browser tests use clearly labelled synthetic products.

Real Meta Model API billing, model access, seller-page freshness and actual Render deployment must still be checked after secrets are configured. Automated tests do not verify live Render settings, account permissions, resource provisioning or model availability.
