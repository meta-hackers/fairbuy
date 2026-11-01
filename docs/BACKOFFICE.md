# Backoffice

The standalone admin UI lives in `backoffice/`. The existing Express server serves
it at `/backoffice/`, with a separate authenticated API at `/api/admin`. No separate
frontend build or service is needed. In development, open the backend port (3001),
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
`render.yaml` or Git. Plaintext configuration is converted to scrypt hashes at
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
All configured admins have the same read-only access to all retained sessions.

To revoke an administrator, remove their entry from BACKOFFICE_ADMINS and restart.
To rotate a password, remove their entry from the local file, generate a replacement
with the command above, update production configuration, and restart. Changing or
removing a credential invalidates its existing sessions. Admin sessions last eight
hours, use opaque random HttpOnly, SameSite=Strict cookies (Secure in production),
and are stored hashed in PostgreSQL. Sign-out revokes the current session. Login
is rate limited. Admin writes use the existing same-origin/header CSRF protection.

## Data and retention

Sessions can be searched by category, session ID, or anonymous browser-owner hash
and filtered by stage and live/demo mode. Detail views expose conversations,
initial/current configuration, feedback, discovery rounds and attempts, products,
offers, source evidence, rankings, selection, and the complete stored record.
Owner hashes identify browsers, not authenticated people. No identity is inferred.

The existing **seven-day expiration and user deletion behavior are unchanged**.
Usage rows cascade-delete with their session. No private archive is kept. Existing
sessions are visible while retained, but usage before this feature cannot be
reconstructed. Without PostgreSQL, demo sessions and admin logins are ephemeral.

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
