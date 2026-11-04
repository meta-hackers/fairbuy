# HTTP API

Same-origin JSON API; no CORS. All writes require `X-Fairbuy-Request: 1`. Browser cookies are sent automatically. POST/PUT bodies use `Content-Type: application/json`; requests are limited to 32 KiB. Errors have `{ "error": "safe message", "code": "..." }`.

`GET /api/bootstrap` establishes a random HttpOnly owner cookie and returns deployment mode, setup/access status, persistence status and the most recently created owned search. It does not reveal keys. Searches are private to this cookie; a UUID alone does not grant access. A configured app password is additionally required.

| Method | Path | Body / behavior |
|---|---|---|
| GET | `/health`, `/healthz` | Public database readiness, no password or AI call. Returns `200` with `{"status":"ok"}`, or `503` with `{"status":"unavailable"}` when the database is unreachable. Responses are not cached. |
| GET | `/api/bootstrap` | Setup status and latest owned search (only after access gate). |
| POST | `/api/access` | `{token}`: validate app password; set HttpOnly access cookie. |
| POST | `/api/instant-classifier` | `{text}`: 3–3000 characters; optional Cloudflare-hosted Meta Llama draft classification. Returns provisional `{category, budget, condition, requirements, clarification}`, each hint quoting whole words of the draft as evidence; never creates or changes a shopping session. Requires app access and CSRF verification. Disabled in demo or without credentials. |
| POST | `/api/location/reverse` | `{latitude, longitude}`: public, rate-limited city/country lookup through a fixed Nominatim endpoint; no AI call. Coordinates are rounded to two decimals, not persisted. Returns `{country, city, currency}`; currency is `null` when the local currency is unsupported. |
| GET | `/api/image?url=…` | Same-origin proxy for accepted product images: validates a public HTTPS target, pins DNS, follows a bounded number of validated redirects, allows raster images up to 5 MB and caches bytes. `400` for an invalid target, `404` when unavailable. Requires app access. |
| GET | `/api/sessions/:id/products/:productId/image` | Load/recover a photo from an owned search, including earlier rounds and products with `imageUrl: null`. Validates image downloads and tries alternative seller metadata. No AI calls or session mutation. Private one-hour success cache; `404`/`IMAGE_UNAVAILABLE` failures are not browser-cached. |
| POST | `/api/client-events` | Strict, rate-limited technical error metadata; requires app access and CSRF verification. Accepts an optional UUID `traceId` (generated if omitted for compatibility). Search/product references are checked against the owner. Enqueues PostgreSQL diagnostics (retention managed externally; no app TTL), logs `client.error`, returns `204` and `X-Trace-Id`. No messages, stacks, full URLs, or arbitrary console logs. See [Client diagnostics](CLIENT_DIAGNOSTICS.md). |
| POST | `/api/sessions` | Create an owned search, optionally seeded with `{location: {country, city, currency}}`; returns `201`. Location alone never marks a brief ready. |
| GET | `/api/sessions/:id` | Complete owned state, or `404`. Poll only while queued/running. |
| DELETE | `/api/sessions/:id` | Close the owned search by appending an archive version; `204`. Does not delete history, jobs or usage. Closed searches return `404` to owner requests. |
| PATCH | `/api/sessions/:id/location` | `{country, city, currency, onlyIfMissing?}`: set shopping location, including during Ask. `onlyIfMissing: true` preserves an existing country; manual edits omit it. Blocked during active discovery. |
| POST | `/api/sessions/:id/ask` | `{message}`: 1–3000 characters; AI response + revised brief. An assistant message may also carry an optional bounded `question` (`prompt`, 2–6 `options` with unique ids, `multiSelect`, `allowFreeText`) for an inline answer card; card answers are sent as ordinary `message` text. Free-text answers are always available in the UI, regardless of the compatibility field `allowFreeText`. |
| PUT | `/api/sessions/:id/configure` | Full validated `ShoppingConfig`; no AI call. |
| POST | `/api/sessions/:id/configure/chat` | `{message}`: separate small-model conversation. |
| POST | `/api/sessions/:id/discovery` | Queue fresh discovery; `202` with session state. Repeated click while pending does not create another round. |
| POST | `/api/sessions/:id/learn` | `{productId: string \| null, reason}`: 1–2000 characters; interpret feedback, discard only the selected product if present, carry the remaining shortlist into a re-ranked new round, queue new round; `202`. |
| DELETE | `/api/sessions/:id/learn/:feedbackId` | Append a feedback revocation and queue fresh discovery; `202`. Previous versions retain the feedback. |
| POST | `/api/sessions/:id/select` | `{productId}`: select a currently eligible product for read-only Buy. |
| POST | `/api/sessions/:id/sellers` | `{productId}`: queue one Buy-stage search for additional sellers of the chosen product in the same market; `202` with session state. Idempotent while pending/running or completed for that product; a failed search can be queued again. Does not re-rank the shortlist or re-evaluate the brief's features. |
| POST | `/api/sessions/:id/missing` | `{query}`: 2–120 characters naming a product or reference. Explains from the latest round's stored data why it is not in the results (shown, removed, excluded, dropped, mentioned, not retrieved or unknown), with next steps, and appends the answer to `round.missingQuestions` (last 20). No model call. Rejected while a search is running or before the first search. |
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

Image requests accept an optional UUID `traceId` query parameter and return it as
`X-Trace-Id` (also in image error JSON). Use the same ID for the initial URL proxy,
owned-product recovery and final browser report. The proxy optionally accepts a
paired `sessionId` and `productId`, validates ownership and checks that the URL is
that product's stored image before attaching those references to diagnostics.
Trace IDs are correlation identifiers, never access credentials. Without a supplied
ID the server generates one; malformed IDs return `400`. The browser keeps a trace
stable for the same product/evidence during a page visit, including the Buy view;
a fresh page visit creates a new attempt. This adds a per-visit cache key; shared
server byte caching still avoids repeated upstream downloads.

Discovery is progressive: a `running` round can already contain grounded `products`, `sources` and a current `ranking`. Render eligible products immediately and continue polling until `complete` or `failed`; do not wait for four cards to render the first one. Mutations remain blocked while searching. Already-persisted products remain available if a later provider request fails. Live searches target at least four distinct eligible models, with up to three complementary search/extraction passes; insufficient evidence is disclosed rather than replaced with invented offers.

`ShoppingSession.sellerSearch` is the optional Buy-stage seller expansion: `{id, productId, productName, attempt, status, createdAt, startedAt, finishedAt, durationMs, offers, sources, summary, error, activities?}`. It is separate from `rounds`, so adding sellers never changes the chosen product, its discovery ranking or its fit score. While `queued` or `running`, show the spinner in the next seller slot and poll the session; when `complete`, render any `offers` as additional seller cards. A `failed` search keeps the original sellers and can be retried explicitly.

Rounds expose nullable `startedAt`, `finishedAt` and `durationMs` alongside `createdAt`. Show elapsed time while queued/running and the recorded duration after completion/failure. Products expose nullable `imageUrl`: a public HTTPS image sharing a site with a research source or a known image CDN. It is the model's grounded official-site image when available; otherwise discovery uses the search provider's thumbnail for one of the product's seller offer pages, which often still works when the seller blocks HTML scraping. The UI first tries known images through `/api/image?url=…`, then uses `GET /api/sessions/:id/products/:productId/image` if that fails or `imageUrl` is null: recovery validates the accepted image, then tries other metadata images and sellers if necessary. Targets come from stored product evidence, never client-supplied recovery URLs. Both paths validate public HTTPS and pinned DNS on every redirect, restrict raster MIME types, check file signatures, bound size and cache bytes. Seller-origin referrers improve CDN compatibility but cannot bypass all anti-bot restrictions; clients must still provide a fallback.

Image downloads that receive **HTTP 403** try `https://wsrv.nl/` once, requesting a 600-pixel-wide WebP. This backend-only fallback applies to both the initial proxy and seller-image recovery/discovery, without changing the stored source image URL or browser CSP. It shares the full public image URL with that third party; no app credentials, cookies or seller referrer are sent. Proxy responses pass the same public-HTTPS/DNS, redirect, size, MIME and signature checks. Successes are cached under the original image URL. The fallback is bounded to eight seconds, respects cancellation, and never nests another wsrv request. Invalid targets, network/DNS failures, missing images, HTTP 429 and other failures are not retried through wsrv. Set `IMAGE_PROXY_FALLBACK=disabled` to opt out (default: `wsrv`). It cannot discover photos from blocked HTML pages or guarantee a blocked image becomes available.

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
- Up to 3 research/extraction passes per round, with 8 extracted products per pass and 4 offers per product/pass; 25 extracted attributes/offer. Repeated models/offers are merged. Each discovery round has a hard five-minute budget; in-flight provider calls are aborted and grounded results found so far are kept.
- One cached Buy-stage seller search per chosen product; at most 8 extracted offers. It has a two-minute budget, keeps only additional sellers in the same market, merges repeated sellers, and never re-ranks offers or re-checks the brief's preferences.
- 45 AI operations/hour/owner; 150 AI operations/day/IP; 1800 API requests/15 minutes/IP. Access-token attempts are separately limited.
- Instant classifier: separate 20 requests/minute/owner and 200/day/IP; at most four concurrent provider calls/process, one/owner, and 500 provider calls per rolling day/process. Eight-second timeout, five-minute owner-isolated memory cache (100 entries), no provider retries. These counters are process-local, not persistent billing guarantees.
- 20 reverse-location lookups/hour/IP. Nominatim requests are limited to one/second/process; rounded city-level results are cached in memory for 24 hours (up to 500 entries). Busy or unavailable lookups fall back to manual entry, not a guessed location.
- Two background searches/process; six-minute lease; maximum two attempts after a process interruption. A provider error is visible and requires an explicit retry.
