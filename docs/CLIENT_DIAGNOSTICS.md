# Browser and image diagnostics

FairBuy sends a small set of browser failures to its own backend. This fills the
gap between server logs and what actually loads in the user's browser; it is not
a session replay tool, general console recorder, or full monitoring platform.

Events are stored in PostgreSQL's dedicated `diagnostic_events` table, created by
idempotent migration `006_diagnostics.sql`. It is separate from immutable shopping
history. Demo mode without a database uses bounded ephemeral memory instead.

## Trace correlation

The browser generates one random UUID `traceId` per product/evidence combination
per page visit. The initial URL-proxy request, recovery request and final image
failure report carry the same ID. Image responses expose `X-Trace-Id`; image error
JSON also includes `traceId`. No custom header is needed on `<img>`: its trace is
a validated query parameter. This creates a per-visit browser cache key, while
server byte caching still prevents repeated upstream downloads. Reopening Buy in
the same page uses the same trace; refreshing the page creates a new attempt.

Server-generated IDs support older clients. Concurrent server work is scoped with
`AsyncLocalStorage`; if requests share recovery/download work, an event's
`relatedTraceId` links to the trace that actually performed it. Discovery image
enrichment gets a separate trace per product, linked to the search and round.
Trace IDs identify operations, **not users and never authorization**.

## What is collected

`POST /api/client-events` accepts only these strict shapes:

- `image_unavailable`: trace/search UUIDs and product ID, sent only after the owned-product
  endpoint fails to deliver a usable photo to the browser.
- `runtime_error`: an allowlisted JavaScript error type, optionally the same-origin
  `/assets/*.js` filename and line/column.
- `unhandled_rejection`: an allowlisted error type, or `UnknownError`.

JavaScript reports also include a trace UUID and the active search UUID when
available; they may occur before a search exists. The server verifies ownership
of every supplied search and product, and derives the round itself. It rejects
unknown fields and malformed IDs. Old clients may omit the trace ID.

Server details are separately allowlisted: operation (`proxy`, `recovery`, `discovery`), domain (not URL), HTTP status, duration,
bounded reason codes, cache/availability flags and related trace IDs. No arbitrary
metadata object or application log stream is persisted. Failed initial loads and
discovery enrichments retain their preceding/succeeding diagnostic steps; entirely
successful ones are not persisted. On-demand recovery retains its completion
steps, including successful recovery, so a later browser decode failure can be
investigated. Each server operation retains at most 50 events (start plus newest
steps), preserving the final outcome even on pages with many candidates.

Messages, stack traces, chat content, console output, full page/resource URLs and
query parameters are not sent. Each page visit deduplicates events and sends at
most 20. The endpoint requires app access and the CSRF header, validates the body,
and is limited to 30 requests per minute per IP, in addition to the API limit.
Reports are best effort: network/reporting failures are ignored, not recursively
reported. Fixture products without photos do not generate image reports.
PostgreSQL also deduplicates browser events by `(traceId, event)` across repeated
submissions. Reports remain untrusted observations, not seller evidence.

## Where to find them

Open **Backoffice → Diagnostics**. Filter by exact trace ID, search ID, origin or
severity; each page has up to 50 events. Clicking a trace opens its chronological
steps. The global feed shows newest first. Search detail includes a diagnostic
shortcut. There is no public read endpoint: `GET /api/admin/diagnostics` requires
the separate admin session. The view identifies PostgreSQL vs ephemeral demo memory.

Events also remain in Render's structured logs for fallback troubleshooting:

| Event | Meaning |
|---|---|
| `client.error` | A browser observed a failure. `kind` distinguishes image, runtime and promise errors. Image events include `sessionId` and `productId`. |
| `image.request.started` / `image.request.completed` | Image endpoint operation and outcome with trace/search/product context. |
| `image.product.resolved` | Recovery/enrichment outcome, including cached selections and capacity limits. |
| `image.fetch.shared` / `image.recovery.shared` | In-flight work was shared; follow `relatedTraceId` where available. |
| `image.page.unavailable` | Seller HTML fetch failed; includes host and HTTP status (`0` for network/timeout/abort). |
| `image.page.no_candidates` | Seller HTML loaded but had no usable product image metadata. |
| `image.fetch.unavailable` | Image download failed; includes host, status and reason (`http_status`, `content_type`, `too_large`, `invalid_image`, or `network_or_timeout`). |

No upstream URL query strings or image bytes are logged. Browser reports are
untrusted diagnostic signals, not evidence that a seller/product is invalid.

For a missing photo, start with `client.error` and its product/search IDs, then
check `image.product.resolved` and nearby upstream failures. A `403` often means
seller/CDN blocking; `404` means a missing upstream resource; status `200` with
`invalid_image` can indicate a challenge/error body masquerading as an image.
If server recovery succeeds but the browser still reports failure, inspect the
browser's Network panel and image decoding rather than changing extraction prompts.

## Retention and limitations

Diagnostic retention is managed **outside the app**. There is no startup/hourly
cleanup, automatic database TTL, or age-based filtering in diagnostic queries.
Older events remain visible until an external retention mechanism deletes them.
The admin API reports `retentionDays: null` to indicate no app-enforced expiry.
Permanent search purge still cascades to linked diagnostics; archiving a search
does not delete them. External retention must also cover reports without a search.
Database backups and Render's stdout/stderr logs have their own retention.

Writes are asynchronous, with at most 1,000 queued events, one writer, batches of
100 and a two-second client query timeout. Database failures log a redacted fallback
event and never fail the shopping/image operation. This is best-effort delivery:
`204` acknowledges acceptance, not a durable commit; overload, process termination
or an unavailable database can lose queued events. There are no paid calls or
unbounded retry loops. Shutdown attempts to flush before closing the pool.
Demo memory holds at most 10,000 events and is not durable across restarts.

The reporter cannot capture failures before the app bundle starts, a completely
offline browser, or every error caught by application code. Minified runtime
positions identify an asset but do not provide symbolicated stacks. Some sellers
block all datacenter downloads, require JavaScript/cookies, or provide no usable
metadata: recovery and logs make those cases visible, not guaranteed solvable.
