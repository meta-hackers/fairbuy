# HTTP API

Same-origin JSON API; no CORS. All writes require `X-Fairbuy-Request: 1`. Browser cookies are sent automatically. POST/PUT bodies use `Content-Type: application/json`; requests are limited to 32 KiB. Errors have `{ "error": "safe message", "code": "..." }`.

`GET /api/bootstrap` establishes a random HttpOnly owner cookie and returns deployment mode, setup/access status, persistence status and the most recently created owned search. It does not reveal keys. Searches are private to this cookie; a UUID alone does not grant access. A configured app password is additionally required.

| Method | Path | Body / behavior |
|---|---|---|
| GET | `/health`, `/healthz` | Public database readiness, no password or AI call. Returns `200` with `{"status":"ok"}`, or `503` with `{"status":"unavailable"}` when the database is unreachable. Responses are not cached. |
| GET | `/api/bootstrap` | Setup status and latest owned search (only after access gate). |
| POST | `/api/access` | `{token}`: validate app password; set HttpOnly access cookie. |
| POST | `/api/location/reverse` | `{latitude, longitude}`: public, rate-limited city/country lookup through a fixed Nominatim endpoint; no AI call. Coordinates are rounded to two decimals, not persisted. Returns `{country, city, currency}`; currency is `null` when the local currency is unsupported. |
| POST | `/api/sessions` | Create an owned search, optionally seeded with `{location: {country, city, currency}}`; returns `201`. Location alone never marks a brief ready. |
| GET | `/api/sessions/:id` | Complete owned state, or `404`. Poll only while queued/running. |
| DELETE | `/api/sessions/:id` | Delete owned search and cascading jobs; `204`. |
| PATCH | `/api/sessions/:id/location` | `{country, city, currency, onlyIfMissing?}`: set shopping location, including during Ask. `onlyIfMissing: true` preserves an existing country; manual edits omit it. Blocked during active discovery. |
| POST | `/api/sessions/:id/ask` | `{message}`: 1–3000 characters; AI response + revised brief. |
| PUT | `/api/sessions/:id/configure` | Full validated `ShoppingConfig`; no AI call. |
| POST | `/api/sessions/:id/configure/chat` | `{message}`: separate small-model conversation. |
| POST | `/api/sessions/:id/discovery` | Queue fresh discovery; `202` with session state. Repeated click while pending does not create another round. |
| POST | `/api/sessions/:id/learn` | `{productId: string \| null, reason}`: 1–2000 characters; interpret feedback, discard selected product if present, queue new round; `202`. |
| DELETE | `/api/sessions/:id/learn/:feedbackId` | Remove one feedback entry and queue fresh discovery; `202`. |
| POST | `/api/sessions/:id/select` | `{productId}`: select a currently eligible product for read-only Buy. |
| PATCH | `/api/sessions/:id/stage` | `{stage}`: persist validated navigation (`ask`, `configure`, `discovery`, `buy`). |

Ask/configure/learn mutations commit only after a valid AI response. Do not automatically retry these POSTs: a network loss after a successful commit could append the same message twice. Refresh owned state first. Discovery POST is idempotent only while a round is pending/running. Configuration/feedback edits during an active search return `409`.

`ShoppingSession`, `ShoppingConfig`, `DiscoveryRound`, product/offer evidence and runtime validators are in [`packages/core/src/`](../packages/core/src/). `version` increases on every committed mutation and allows clients to ignore out-of-order poll responses.

Discovery is progressive: a `running` round can already contain grounded `products`, `sources` and a current `ranking`. Render eligible products immediately and continue polling until `complete` or `failed`; do not wait for four cards to render the first one. Mutations remain blocked while searching. Already-persisted products remain available if a later provider request fails. Live searches target at least four distinct eligible models, with up to three complementary search/extraction passes; insufficient evidence is disclosed rather than replaced with invented offers.

## Configuration example

```json
{
  "category": "laptop",
  "purpose": "Programming while travelling",
  "budgetMax": 700,
  "budgetHard": true,
  "currency": "EUR",
  "country": "IT",
  "city": "Milan",
  "requirements": [{
    "label": "At least 16 GB RAM",
    "hard": true,
    "attribute": "ramGb",
    "op": ">=",
    "value": 16,
    "unit": "GB"
  }]
}
```

Budget values in configuration are major currency units; offer prices and the pseudo-attribute `total` use integer minor units. Uninterpreted requirements retain `label` and nullable structured fields; they remain part of research but do not pass a deterministic constraint without evidence.

## Limits

- 15 owned searches per retention window; 20 editable requirements; 40 messages (20 user turns) in each conversation.
- 12 discovery rounds/search; 30 feedback entries; up to 5 learned requirements/feedback.
- Up to 3 research/extraction passes per round, with 8 extracted products per pass and 4 offers per product/pass; 25 extracted attributes/offer. Repeated models/offers are merged.
- 45 AI operations/hour/owner; 150 AI operations/day/IP; 1800 API requests/15 minutes/IP. Access-token attempts are separately limited.
- 20 reverse-location lookups/hour/IP. Nominatim requests are limited to one/second/process; rounded city-level results are cached in memory for 24 hours (up to 500 entries). Busy or unavailable lookups fall back to manual entry, not a guessed location.
- Two background searches/process; five-minute lease; maximum two attempts after a process interruption. A provider error is visible and requires an explicit retry.
