# Browser and image diagnostics

FairBuy sends a small set of browser failures to its own backend. This fills the
gap between server logs and what actually loads in the user's browser; it is not
a session replay tool, general console recorder, or full monitoring platform.

## What is collected

`POST /api/client-events` accepts only these strict shapes:

- `image_unavailable`: search UUID and product ID, sent only after the owned-product
  endpoint fails to deliver a usable photo to the browser.
- `runtime_error`: an allowlisted JavaScript error type, optionally the same-origin
  `/assets/*.js` filename and line/column.
- `unhandled_rejection`: an allowlisted error type, or `UnknownError`.

Messages, stack traces, chat content, console output, full page/resource URLs and
query parameters are not sent. Each page visit deduplicates events and sends at
most 20. The endpoint requires app access and the CSRF header, validates the body,
and is limited to 30 requests per minute per IP, in addition to the API limit.
Reports are best effort: network/reporting failures are ignored, not recursively
reported. Fixture products without photos do not generate image reports.

## Where to find them

In the existing Render service logs, filter the structured JSON `event` field:

| Event | Meaning |
|---|---|
| `client.error` | A browser observed a failure. `kind` distinguishes image, runtime and promise errors. Image events include `sessionId` and `productId`. |
| `image.product.resolved` | On-demand recovery finished; includes `productId`, availability, offer count and elapsed time. Cached selections do not emit another completion event. |
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

These events go to backend stdout/stderr, not PostgreSQL or the backoffice.
Their retention and access controls are those of Render's logging configuration.
There is no durable in-app archive; a log drain or dedicated monitoring service
would be a separate integration if longer retention becomes necessary.

The reporter cannot capture failures before the app bundle starts, a completely
offline browser, or every error caught by application code. Minified runtime
positions identify an asset but do not provide symbolicated stacks. Some sellers
block all datacenter downloads, require JavaScript/cookies, or provide no usable
metadata: recovery and logs make those cases visible, not guaranteed solvable.
