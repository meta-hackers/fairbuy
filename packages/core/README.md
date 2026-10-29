# @fairbuy/core

Shared data contract, category specs, synthetic fixtures, and the deterministic ranking engine. **Draft** implementation of [meta-hackers/fairbuy#1](https://github.com/meta-hackers/fairbuy/issues/1): it follows the choices proposed there and will change with the review.

## Layout

| Path | Contents |
|---|---|
| `src/contract.ts` | Zod schemas and inferred types: `Offer`, `Field<T>`, `PriceBreakdown`, `CategorySpec`, `Constraint`, `ConnectorError` |
| `src/categories/` | Category specs (configuration). Only `laptop` for now |
| `src/ranking/` | Total cost, constraint evaluation, filtering and scoring |
| `fixtures/laptop/` | Synthetic offers A/B/C from the demo (PROPOSAL §4). Not current offers |
| `test/` | Contract validation and ranking scenarios |

## How the ranking works

1. **Total cost:** sum of price components; flagged as a lower bound when a cost is missing or unknown.
2. **Feasibility before scoring:** each hard constraint is `pass`, `fail`, or `unknown`.
   - Any `fail` (or sold out) → **excluded**, with reasons.
   - Any `unknown` (or availability not confirmed) → **unverified**: still shown, never treated as passing.
   - An incomplete total whose known minimum already exceeds the budget is a sure `fail`.
3. **Score** (feasible and unverified only), weights from PROPOSAL §7 and overridable:
   - `cost` (0.50): min–max normalized total across candidates.
   - `suitability` (0.30): share of soft constraints that pass.
   - `reliability` (0.20): how well-sourced the relevant data is (verified 1, seller claim 0.6, estimate 0.4, unknown 0; each declared missing field counts as unknown). This is data quality, not product quality.
4. **Warnings:** synthetic data, near ties (difference < 0.02), and incomplete totals that rank above other offers.

Same offers + constraints + weights + `RANKING_VERSION` → same result, independent of input order.

## Scripts

From the repository root:

```bash
npm install
npm test
npm run typecheck
```

## Deviations from the issue

- `Constraint.value` also accepts `boolean` (needed for constraints like `chargerIncluded = true`).
- `PriceComponent` has an optional `label` (e.g. "Pickup travel").
- Workspaces use **npm** instead of pnpm, to avoid an extra tool until the monorepo question is settled.
