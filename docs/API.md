# HTTP API

Same-origin JSON API; no CORS. All writes require `X-Fairbuy-Request: 1`. Browser cookies are sent automatically. POST/PUT bodies use `Content-Type: application/json`; requests are limited to 32 KiB. Errors have `{ "error": "safe message", "code": "..." }`.

`GET /api/bootstrap` establishes a random HttpOnly owner cookie and returns deployment mode, setup/access status, persistence status and the most recently created owned search. It does not reveal keys. Searches are private to this cookie; a UUID alone does not grant access. A configured app password is additionally required.

| Method | Path | Body / behavior |
|---|---|---|
| GET | `/health`, `/healthz` | Public database readiness, no password or AI call. Returns `200` with `{"status":"ok"}`, or `503` with `{"status":"unavailable"}` when the database is unreachable. Responses are not cached. |
| GET | `/api/bootstrap` | Setup status and latest owned search (only after access gate). |
| POST | `/api/access` | `{token}`: validate app password; set HttpOnly access cookie. |
| POST | `/api/instant-classifier` | `{text}`: 3–3000 characters; optional Cloudflare-hosted Meta Llama draft classification. Returns provisional `{category, budget, condition, requirements, clarification}` with exact quoted evidence; never creates or changes a shopping session. Requires app access and CSRF verification. Disabled in demo or without credentials. |
| POST | `/api/location/reverse` | `{latitude, longitude}`: public, rate-limited city/country lookup through a fixed Nominatim endpoint; no AI call. Coordinates are rounded to two decimals, not persisted. Returns `{country, city, currency}`; currency is `null` when the local currency is unsupported. |
| POST | `/api/sessions` | Create an owned search, optionally seeded with `{location: {country, city, currency}}`; returns `201`. Location alone never marks a brief ready. |
| GET | `/api/sessions/:id` | Complete owned state, or `404`. Poll only while queued/running. |
| DELETE | `/api/sessions/:id` | Close the owned search by appending an archive version; `204`. Does not delete history, jobs or usage. Closed searches return `404` to owner requests. |
| PATCH | `/api/sessions/:id/location` | `{country, city, currency, onlyIfMissing?}`: set shopping location, including during Ask. `onlyIfMissing: true` preserves an existing country; manual edits omit it. Blocked during active discovery. |
| POST | `/api/sessions/:id/ask` | `{message}`: 1–3000 characters; AI response + revised brief. |
| PUT | `/api/sessions/:id/configure` | Full validated `ShoppingConfig`; no AI call. |
| POST | `/api/sessions/:id/configure/chat` | `{message}`: separate small-model conversation. |
| POST | `/api/sessions/:id/discovery` | Queue fresh discovery; `202` with session state. Repeated click while pending does not create another round. |
| POST | `/api/sessions/:id/learn` | `{productId: string \| null, reason}`: 1–2000 characters; interpret feedback, discard selected product if present, queue new round; `202`. |
| DELETE | `/api/sessions/:id/learn/:feedbackId` | Append a feedback revocation and queue fresh discovery; `202`. Previous versions retain the feedback. |
| POST | `/api/sessions/:id/select` | `{productId}`: select a currently eligible product for read-only Buy. |
| PATCH | `/api/sessions/:id/stage` | `{stage}`: persist validated navigation (`ask`, `configure`, `discovery`, `buy`). |

Ask/configure/learn mutations commit only after a valid AI response. Do not automatically retry these POSTs: a network loss after a successful commit could append the same message twice. Refresh owned state first. Discovery POST is idempotent only while a round is pending/running. Configuration/feedback edits during an active search return `409`.

State changes append immutable versions, never overwrite the session. AI generation
runs outside database transactions; if its source version changed before saving,
the response is `409` with code `SESSION_CONFLICT`, and no stale result is appended.
Refresh and let the user decide whether to retry; do not automatically repeat paid
provider calls. No-op changes do not increment `version`. Sessions do not expire
automatically; physical deletion is a separate backoffice maintenance command.

`ShoppingSession`, `ShoppingConfig`, `DiscoveryRound`, product/offer evidence and runtime validators are in [`packages/core/src/`](../packages/core/src/). `version` increases on every committed mutation and allows clients to ignore out-of-order poll responses.

The separately authenticated administrator API, including immutable history and confirmed deletion maintenance, is documented in [Backoffice](BACKOFFICE.md). It uses `/api/admin` routes and is not part of the anonymous shopping-session API described below.

Discovery is progressive: a `running` round can already contain grounded `products`, `sources` and a current `ranking`. Render eligible products immediately and continue polling until `complete` or `failed`; do not wait for four cards to render the first one. Mutations remain blocked while searching. Already-persisted products remain available if a later provider request fails. Live searches target at least four distinct eligible models, with up to three complementary search/extraction passes; insufficient evidence is disclosed rather than replaced with invented offers.

Rounds expose nullable `startedAt`, `finishedAt` and `durationMs` alongside `createdAt`. Show elapsed time while queued/running and the recorded duration after completion/failure. Products expose nullable `imageUrl`: a public HTTPS image sharing a site with a research source, requested from official product sites. Images can be unavailable; clients should provide a fallback.

Offer `price` is `{currency, amountCents}` with nullable `amountCents`. It represents only the final listed product price; no shipping/delivery or fee estimates are included. Ranked offers expose `price: {cents, known}`. Unknown prices are not zero-price offers. The legacy `item`, `shipping` and `fees` price fields are no longer returned.

## Instant classifier

`GET /api/bootstrap` also returns `instantClassifierConfigured`, a boolean only; no Cloudflare credentials are exposed. Show the typing-preview disclosure before sending drafts. Classifier output is a separate contract in `packages/core/src/instant-classifier.ts`, not confirmed `ShoppingConfig`. Unknown values are `null`; an explicit amount without an explicit supported currency retains `currency: null`. An unavailable/invalid provider result returns `503`, and a busy/exhausted preview returns `429`; neither prevents normal Ask submission. Do not automatically retry previews.

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

Budget values in configuration are major currency units; offer prices and the pseudo-attribute `total` use integer minor units. `total` now means the final listed product price, not a delivered total. Uninterpreted requirements retain `label` and nullable structured fields; they remain part of research but do not pass a deterministic constraint without evidence.

## Limits

- 15 active owned searches (closed searches do not count); 20 editable requirements; 40 messages (20 user turns) in each conversation.
- 12 discovery rounds/search; 30 feedback entries; up to 5 learned requirements/feedback.
- Up to 3 research/extraction passes per round, with 8 extracted products per pass and 4 offers per product/pass; 25 extracted attributes/offer. Repeated models/offers are merged.
- 45 AI operations/hour/owner; 150 AI operations/day/IP; 1800 API requests/15 minutes/IP. Access-token attempts are separately limited.
- Instant classifier: separate 20 requests/minute/owner and 200/day/IP; at most four concurrent provider calls/process, one/owner, and 500 provider calls per rolling day/process. Eight-second timeout, five-minute owner-isolated memory cache (100 entries), no provider retries. These counters are process-local, not persistent billing guarantees.
- 20 reverse-location lookups/hour/IP. Nominatim requests are limited to one/second/process; rounded city-level results are cached in memory for 24 hours (up to 500 entries). Busy or unavailable lookups fall back to manual entry, not a guessed location.
- Two background searches/process; five-minute lease; maximum two attempts after a process interruption. A provider error is visible and requires an explicit retry.
