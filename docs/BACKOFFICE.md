# Backoffice

The standalone admin UI lives in `backoffice/`. The existing Express server serves
it at `/backoffice/`, with a separate authenticated API at `/api/admin`. No separate
frontend build or service is needed. In development, open the backend port (`PORT`, default 4000),
not the shopping frontend's Vite port.

See [deployment configuration](DEPLOYMENT.md#environment) for the Render environment
variable and [HTTP API](API.md) for the public shopping API. Admin endpoints use a
separate session and must not be treated as endpoints available to shopping users.

## Administrator accounts

For simple setup, set **BACKOFFICE_ADMINS** directly in Render's environment
settings using a JSON array of usernames and plaintext passwords:

```json
[{"username":"ExampleAdmin","password":"replace-with-a-long-unique-password"}]
```

Use a separate entry for each administrator. Do not commit real passwords to
Git. Plaintext configuration is converted to scrypt hashes at
startup and is never included in API responses. Existing `passwordHash` entries
remain supported; each entry must contain exactly one of `password` or
`passwordHash`. Changing a password invalidates existing sessions after restart.
Plaintext values remain visible to people with access to Render environment
settings. Prefer long unique passwords, especially for production.

For generated passwords and hash-only configuration, run the following instead.
From the repository root:

```sh
npm run admin:create -- Alberto
npm run admin:create -- AnotherAdmin
```

Each command generates a unique strong password and prints it once. Save it in a
password manager. Only salted scrypt hashes are saved to the git-ignored,
owner-readable `.env.backoffice`. `npm start` and the backend development command
load this file automatically. Restart the backend after account changes.

On Render, set **BACKOFFICE_ADMINS** to the JSON array from `.env.backoffice`
(omit the environment assignment and surrounding single quotes), then redeploy.
Do not commit the file or the passwords. Existing app access credentials do not
grant admin privileges. With no admin configuration, the admin API fails closed.
All configured admins can inspect every session and run confirmed permanent-deletion maintenance. Configure only trusted maintenance operators; there is not yet a separate read-only administrator role.

To revoke an administrator, remove their entry from BACKOFFICE_ADMINS and restart.
To rotate a password, remove their entry from the local file, generate a replacement
with the command above, update production configuration, and restart. Changing or
removing a credential invalidates its existing sessions. Admin sessions last eight
hours, use opaque random HttpOnly, SameSite=Strict cookies (Secure in production),
and are stored hashed in PostgreSQL. Sign-out revokes the current session. Login
is rate limited. Admin writes use the existing same-origin/header CSRF protection.

## Discovery source catalog

The **Sources** tab is a read-only view of the catalog published by the separate
[fairbuy-sources-catalog](https://github.com/meta-hackers/fairbuy-sources-catalog)
repository. Canonical data lives in that repository's `sources.json`; the public
page is https://meta-hackers.github.io/fairbuy-sources-catalog/.

The catalog is stored only in PostgreSQL. After migrations, the app loads the
last complete sync from the database, so a restart keeps the latest catalog
without a bundled snapshot or an immediate GitHub request. Clicking
**Sync from GitHub** calls `POST /api/admin/sources/sync`, which:

- fetches `CATALOG_URL` over HTTPS with a 10 s timeout, no redirects and a 512 KB cap;
- requires a `schemaVersion: 1` envelope with an `entries` array;
- validates every entry with `SourceEntrySchema` and rejects duplicate domains;
- deletes and rewrites every catalog row in one transaction only when the whole payload is valid.

On failure it keeps the last-known-good catalog in both the database and memory,
and shows the error. Discovery never fetches GitHub directly; an in-flight round
keeps the plan it started with.

The Sources view shows entries, source (`GitHub` after a sync, `Database` after a
load), last sync time, version, count and the configured URL. It has filters but
no editor: edit `sources.json` in the catalog repository and open a PR. CI
validates it and GitHub Pages publishes it. A fresh database is empty until the
first sync. When `CATALOG_SYNC_ON_START=true`, the app also attempts a background
sync at startup; it never blocks readiness.

The admin API is:

- `GET /api/admin/sources`: current entries plus source status, roles and verticals.
- `POST /api/admin/sources/sync`: fetch, validate and replace the catalog.

Both routes require an admin session; the POST also requires the normal CSRF header.

## Data and retention

Sessions can be searched by category, session ID, or anonymous browser-owner hash
and filtered by stage and live/demo mode. Detail views expose conversations,
initial/current configuration, feedback, discovery rounds and attempts, products,
offers, source evidence, rankings, selection, and the complete stored record.
Owner hashes identify browsers, not authenticated people. No identity is inferred.

Sessions and version history have **no automatic expiration or cleanup**. “New
search” appends a closed/archive version; it does not delete data. Closed sessions
remain visible here. Anonymous owner cookies still expire after seven days, but
that does not remove stored sessions. Usage before instrumentation and versions
before the append-only migration cannot be reconstructed. Without PostgreSQL,
demo sessions, versions and admin logins are ephemeral.

The detail view's **Immutable version history** section loads the stored snapshots,
including parent versions, archive events and feedback revocations. Snapshots
include conversations: treat them as private data, not public diagnostic logs.

### Maintenance commands

In a session detail, choose **Permanently delete this session** and type its exact
UUID. This explicitly purges the identity and all versions, legacy child rows,
jobs and usage through foreign-key cascades. It cannot be undone; other sessions
are unaffected. The server enforces admin authentication, the normal CSRF/origin
checks and matching confirmation. The completion event logs the admin and UUID,
not session contents. Database backups have their own retention.

Admin API additions:

- `GET /api/admin/sessions/:sessionId/history`: ordered immutable revisions and snapshots.
- `POST /api/admin/sessions/:sessionId/purge`: JSON `{ "confirmSessionId": "<same UUID>" }`; returns `204`.
- `GET /api/admin/sources` and `POST /api/admin/sources/sync` as described above.
- `GET /api/admin/me`: `retentionDays: null` indicates no automatic expiry.

## Token accounting and approximate costs

Every instrumented Meta call records model/provider, phase, operation, status,
duration and provider-reported input/output tokens, including incomplete responses
when reported. Cached input and reasoning tokens are informational subsets of
input/output, not extra tokens to add. Usage is committed separately after shopping
transactions finish, including calls whose resulting session mutation rolled back.
If provider usage is unavailable (timeouts, interrupted streams, rejected calls),
it stays null, not zero. A persistence failure is logged, not allowed to break the
shopping operation. Totals are of recorded calls only, not a billing guarantee.

Discovery includes each research and extraction call across passes and worker
attempts, associated with its round ID. Feedback interpretation has a separate
`learn` phase. Brave search calls are recorded with unknown token usage/cost; search
and tool charges are not inferred. Cloudflare preview calls are attributed to the
latest session of that browser **only when a session already exists**. Pre-session
previews are not stored. Cache hits do not represent a new paid call. Raw preview
drafts and raw provider bodies remain unpersisted.

Set **AI_PRICE_TABLE** to a JSON object mapping model names to assumed USD prices
per million input/output tokens. A `*` entry supplies the fallback:

```json
{"*":{"input":1,"output":3},"your-model":{"input":0.5,"output":2}}
```

The default fallback ($1 input / $3 output per million) is an **illustrative
budgeting assumption, not a claim about any provider's actual pricing**. The UI
shows the configured rates. Set real model-specific rates for a better estimate,
or `{}` to leave costs unknown. Cost = (input × input rate + output × output rate)
/ 1,000,000. Discounts, cache discounts, search/tool fees, taxes, free quotas and
other adjustments are excluded. Estimates are stored at call time; changing rates
does not rewrite historical estimates. Totals with missing costs are partial.
