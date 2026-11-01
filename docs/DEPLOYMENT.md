# Render + Supabase deployment

## Prerequisites

- The implementation is committed/pushed to `meta-hackers/fairbuy` on the branch you intend to deploy. Local changes alone are not visible to Render.
- A Render account connected to that GitHub repository, with permission to create resources.
- Access to Render **My Workspace** and the Supabase `fairbuy` project. The app does not use Supabase Auth or the browser Data API.
- A Meta Model API key from [dev.meta.ai](https://dev.meta.ai) with billing, access to the configured model (`muse-spark-1.3-contributor`), the Responses API (search grounding) and structured output. Pay-as-you-go Contributor mode is lower cost in exchange for Meta possibly using submitted content to train its models.

## Blueprint

The root `render.yaml` defines the web deployment, not a Render PostgreSQL instance:

| Resource | Location | Configuration |
|---|---|---|
| Render workspace `My Workspace` | `tea-db0m51s9v7es73c21lf0` | Active deployment; select explicitly in the Dashboard/API |
| Render Blueprint `fairbuy` | `exs-dbjgfmmtlv9c73d5gjng` | Reuse this existing Blueprint |
| Render project / environment | `fairbuy` / `production` | Declared in the Blueprint |
| Render web service `fairbuy` | Virginia, `srv-dbjgia67bikc73fd27tg` | Free plan, one instance; https://fairbuy.onrender.com |
| Supabase project `fairbuy` | `ekhurxapawdqcaqvqrwu`, Ireland (`eu-west-1`) | Database `postgres`, private schema `fairbuy` |

The Blueprint deliberately has no `databases:` declaration or `fromDatabase` reference. Supabase resources are managed separately. A Render project name does **not** select its workspace; workspace ownership must be set explicitly when creating the Blueprint/service.

Do not move the web service to Frankfurt/EU for Meta calls: in testing, Meta Model API returned `404 model_not_found` for both `muse-spark-1.3-contributor` and `muse-spark-1.3` from Frankfurt, while the same key worked from Switzerland and from Render Virginia.

### Create or attach the Blueprint

1. Configure Supabase as below, then push the deployment changes to `https://github.com/meta-hackers/fairbuy`. The service follows the Blueprint branch; there is no hardcoded `main` override.
2. In the Render Dashboard, select **My Workspace → Blueprints → fairbuy**. The separate workspace named `fairbuy` is not the active deployment target.
3. Reuse the existing Blueprint and service IDs above. Retry a failed sync with **Manual Sync**, reviewing/approving its plan if prompted; do not recreate the resources to clear an error. For a genuinely new deployment only, use **New → Blueprint**, or **Generate Blueprint** to adopt existing resources rather than replicate them. Initial Blueprint creation/approval requires the Dashboard; the public API supports validation and updating existing Blueprints but does not expose creation.
4. Review the sync plan: the project must be `fairbuy`, its environment `production`, the service plan `free`, and there must be **no Render database**. When adopting the API-created service, verify its ID rather than accepting a suffixed duplicate.
5. Supply or preserve `DATABASE_URL`, `MODEL_API_KEY` and `APP_ACCESS_TOKEN` as secrets. They use `sync: false`; do not paste their values into Git. A later Blueprint sync leaves these variables unchanged, but recreating a service does **not** copy the old service's secrets. A missing `DATABASE_URL` prevents production startup. Keep the app password configured even when the model key is supplied later.
6. Approve/sync, then verify the Blueprint, project and service all belong to workspace `tea-db0m51s9v7es73c21lf0` and https://fairbuy.onrender.com/healthz succeeds.
7. Smoke-test live Ask → Configure → Discovery → Learn → Buy using a small request. Check clickable citations and the live/preview banner. Confirm that prices/charges/stock not found in evidence remain unknown. Watch API billing/latency.

Render builds with `npm ci --include=dev && npm run build` and starts with `npm start`. Free web services do not support `preDeployCommand`; instead, the app safely initializes schema at startup before accepting requests. `npm run db:migrate` remains available for explicit maintenance runs. `/healthz` checks database availability, not paid AI access. Without a valid `MODEL_API_KEY`, the app serves setup guidance and never substitutes demo results. `APP_ACCESS_TOKEN` is the fixed app password, not a per-user account.

## Supabase PostgreSQL

Use a dedicated `fairbuy_app` login, **not** the Supabase administrator password. Run [`scripts/setup-supabase.sql`](../scripts/setup-supabase.sql) once as the Supabase `postgres` administrator. Supply `FAIRBUY_DATABASE_PASSWORD` securely through the environment (a random value of at least 32 characters), together with the administrator connection settings `PGHOST`, `PGUSER` and `PGPASSWORD` from Supabase's Connect dialog:

```sh
PGSSLMODE=verify-full PGSSLROOTCERT=certs/supabase-ca.crt \
  psql -d postgres -f scripts/setup-supabase.sql
```

The script creates a private schema owned by `fairbuy_app` and sets that login's database-specific `search_path` to `fairbuy, pg_catalog`. The login cannot administer other databases or roles. Supabase's `anon` and `authenticated` browser roles have no access to the schema. Do not expose `fairbuy` through the Data API or grant those roles access; all application traffic goes through Express and its existing owner checks. The script refuses to overwrite an existing role/schema; password rotation is a separate administrative action.

Use **Connect → Session pooler**, port **5432**, for the Render backend's IPv4 connections. Copy the pooler host from Supabase (do not derive the pooler cluster index from its region). Set Render's secret `DATABASE_URL` to this form, percent-encoding the generated role password:

```text
postgresql://fairbuy_app.<project-ref>:<percent-encoded-password>@<session-pooler-host>:5432/postgres?sslmode=verify-full&sslrootcert=certs/supabase-ca.crt
```

The checked-in [public Supabase root certificate](../certs/README.md) verifies the server certificate and hostname. Run the app from the repository root (`npm start`) so the certificate path resolves. Never disable certificate verification to work around a connection error. The PostgreSQL store creates immutable session identities and `session_versions`, legacy normalized tables, usage/admin tables and `discovery_jobs` inside the private schema on startup; no Supabase SDK, service-role API key or frontend credentials are required.

Before upgrading a populated deployment, take and verify a database backup. Startup migration converts any pre-normalization JSONB state, then migration `004_session_versions.sql` creates one immutable baseline per existing session at its current version. Earlier versions cannot be recovered. Existing normalized rows remain untouched after this baseline, and repeated migrations do not create duplicate baselines. Invalid legacy conversion aborts the migration rather than deleting a session. Allow migration to finish before sending traffic; inspect logs and verify existing searches. Stop/drain the old deployment's writers before migration: old application versions cannot write against the immutable schema. Rolling back application code alone is not supported; use a verified database backup and coordinated rollback.

`SUPABASE_PAT` is an operator-only management credential, not an app runtime variable. If it is set in the ignored `.env`, explicitly load that value for management operations rather than assuming a stale inherited shell variable has been overridden. Never print or commit the token.

### Replacing the initial Render deployment

Render cannot transfer an existing service between workspaces. The active deployment is now back in **My Workspace**, using its original `fairbuy.onrender.com` hostname and the existing Blueprint/service IDs above. Do not move or recreate it as part of ordinary configuration changes. If a future workspace change is explicitly requested, retain all connection/provider/password secrets securely before deleting anything; a replacement service does not inherit them. Disconnect an obsolete Blueprint **before** deleting its resources, otherwise a future sync can recreate them. The previous Render PostgreSQL database has already been removed and must not be reintroduced into the Blueprint.

The owner explicitly approved discarding the initial Render database's data and downtime during this early-stage reset. This is not a general migration policy: take and verify backups before deleting any future populated deployment. Do not remove unrelated services from `My Workspace`.

Automatic deploys wait for GitHub checks to pass. This repository supplies CI with typechecking, build, PostgreSQL tests, Blueprint validation, dependency audit and mobile/desktop browser tests. On first deploy or if no checks run, use Render’s manual deploy controls as needed.

## Environment

| Variable | Default / purpose |
|---|---|
| `DATABASE_URL` | Secret Supabase Session pooler URL for `fairbuy_app.<project-ref>`, database `postgres`, with `sslmode=verify-full&sslrootcert=certs/supabase-ca.crt`; mandatory in live/production mode. |
| `MODEL_API_KEY` | Server-only secret; may be configured later without rebuilding frontend assets. |
| `ASK_MODEL` | `muse-spark-1.3-contributor`; question-asking and structured brief. |
| `CONFIGURE_MODEL` | `muse-spark-1.3-contributor`; Configure and Learn interpretation calls. |
| `DISCOVERY_MODEL` | `muse-spark-1.3-contributor`; discovery research and evidence extraction. |
| `ASK_REASONING_EFFORT` | `low`; Ask conversation and structured brief. |
| `CONFIGURE_REASONING_EFFORT` | `low`; Configure and Learn interpretation calls. |
| `DISCOVERY_REASONING_EFFORT` | `xhigh`; Meta discovery research. Mechanical evidence extraction stays at `low`, including with Brave search. |
| `SEARCH_PROVIDER` | `brave` (default; requires `BRAVE_API_KEY`) or `meta` (alternative; no extra search key needed). |
| `BRAVE_API_KEY` | Required secret for the default `SEARCH_PROVIDER=brave` (`sync: false` in Blueprint); the Meta key is still required for interpretation/extraction. |
| `INSTANT_CLASSIFIER_PROVIDER` | `disabled` unless set; the Blueprint sets `cloudflare`. Preview still requires both Cloudflare credentials and live mode. |
| `INSTANT_CLASSIFIER_MODEL` | `@cf/meta/llama-3.1-8b-instruct-fp8-fast` (default); fallback is `@cf/meta/llama-3.2-3b-instruct`. The 1B model rejects the required JSON Schema requests. Ordinary Instruct models, no separate thinking phase. See [model choices](INSTANT_CLASSIFIER.md#model-choices). |
| `CLOUDFLARE_ACCOUNT_ID` | Optional server-only account identifier (`sync: false`), 32 hexadecimal characters. Not a Zone ID. |
| `CLOUDFLARE_API_TOKEN` | Optional server-only Workers AI Read + Edit token restricted to that account (`sync: false`). Never use the Global API Key or expose in `VITE_*`. |
| `APP_ACCESS_TOKEN` | Fixed app password set in Render (`sync: false` in the Blueprint). Local empty value disables gate; not recommended for a public deployment. |
| `APP_ORIGIN` | Optional exact HTTPS public origin for a custom domain, with no trailing slash. Default uses Render’s `RENDER_EXTERNAL_URL`. |
| `FAIRBUY_MODE` | `live`; use `demo` only for an explicitly labelled scripted preview. |
| `NODE_ENV` | `production` on Render: Secure cookies and database requirement. |
| `PORT` | Render-injected listen port (normally `10000`); fallback `4000` when unset/empty. The server binds to `0.0.0.0`, as required by [Render port binding](https://render.com/docs/web-services#port-binding). |
| `NODE_VERSION` | Tested/pinned in Blueprint and `.node-version`. |

Reasoning effort settings accept `minimal`, `low`, `medium`, `high` or `xhigh`; `"max"` is not supported by the Contributor model. They replace the old shared `REASONING_EFFORT` variable, which is no longer used. Set the per-stage variables in your local `.env` or Render environment and restart/redeploy for changes to take effect.

Use model IDs your account actually supports. Defaults are configurable, not an assurance of account access. Provider errors are intentionally redacted; check model names, credits and provider dashboards. Never put secrets in `VITE_*`, frontend source, URLs or Git.

## Optional Cloudflare instant classifier

Create a Free Cloudflare account, then open Workers AI → Use REST API → Create a Workers AI API Token. Keep the restricted Read + Edit template and copy the account ID and token into the two server-only variables above. Set `INSTANT_CLASSIFIER_PROVIDER=cloudflare`. No domain, DNS change, Cloudflare Worker or paid plan is required. See [Cloudflare's REST setup](https://developers.cloudflare.com/workers-ai/get-started/rest-api/).

Render never reads a developer's local `.env` automatically. Set these four classifier variables on the existing `fairbuy` service without replacing unrelated environment variables; the Blueprint deliberately leaves credentials as `sync: false`. Deploy the integration code before expecting the new bootstrap flag or preview. Changing secrets alone does not deploy a local worktree. Leave `MODEL_API_KEY`, the main models, database and app password untouched.

Cloudflare currently grants 10,000 neurons/day, not 10,000 requests. On Workers Free, excess usage fails until the quota resets; upgrading to Paid allows charges beyond the allowance. Review [current pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/). FairBuy treats all quota/provider/validation errors as a missing preview and keeps Send available. No automatic fallback spends Meta Model API credits. The application has process-local rate/call caps, not a provider-wide spending guarantee.

The preview disclosure appears before typing. Only the draft is sent, not the conversation or stored location. Cached previews are owner-isolated and expire after five minutes; provider retention policies still apply. Test with a synthetic draft and verify the classifier responds without changing session readiness. The automated suite uses HTTP mocks and never calls Cloudflare.

## Optional Brave search

Set `SEARCH_PROVIDER=brave` (default) with `BRAVE_API_KEY` set, and redeploy/restart. This implementation uses Brave Web Search snippets, not full page extraction or CAPTCHA bypassing. Results may be sparse, and unrelated comparison articles are not seller offers. `SEARCH_PROVIDER=meta` keeps Meta hosted web search as the alternative without code changes. Crawlora is not implemented or required.

## Operations and recovery

- Keep **one web instance** until rate limits are backed by shared storage. PostgreSQL claims can coordinate workers across processes, but current abuse limiters are process-local.
- Jobs survive redeploys. A terminated job’s five-minute lease expires; it is reclaimed on a subsequent worker tick. After two interrupted attempts it fails visibly. A provider failure does not automatically burn another call; Refresh queues a new round subject to limits.
- Render gets up to 300 seconds for graceful shutdown; the app waits for active jobs/API calls, then closes PostgreSQL. Abrupt termination still uses lease recovery.
- Database retention: no automatic expiry or pruning. “New search” archives the current search without deleting versions, jobs or usage. Only confirmed backoffice maintenance purges a selected session. Complete state snapshots consume increasing storage; monitor database size and perform maintenance intentionally. Configure Supabase backups/recovery according to your own privacy/reliability policy.
- Review Supabase's plan limits, inactivity pausing and backup/recovery coverage before relying on this as a production service. Application retention is separate from provider retention and backups.
- Set Meta Model API/Brave project billing budgets/alerts. Rate limits, output tokens, search tool limits and two concurrent jobs reduce usage but are **not a dollar-denominated spending guarantee**. Rotate `APP_ACCESS_TOKEN` and API keys if exposed.
- Custom domain: set `APP_ORIGIN=https://your-domain.example` exactly. Browser writes from other origins are rejected. API and frontend must stay on the same origin.
- Structured one-line JSON logs cover HTTP outcomes, session/queue/worker activity, provider calls, discovery passes and database migration, with elapsed milliseconds and result counts. Logs intentionally omit request bodies, chat text, prompts, secrets and upstream error bodies. Provider failures include HTTP status, model, provider error code/type/param and request id. Informational logs are suppressed in tests unless `FAIRBUY_LOG=1`. Do not add secret/prompt logging during troubleshooting.

## What is not deployed by the code

The Blueprint describes only the Render web deployment; Supabase provisioning and connection secrets are managed separately. Editing/validating YAML alone does not attach live resources to a Blueprint. Verify the workspace and resource IDs after syncing. No resources, external transactions or paid provider calls are created during the test suite. Account auth, seller inventory integrations, screenshots/audio, arbitrary crawling and payments are not implemented.
