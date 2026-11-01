# Render deployment

## Prerequisites

- The implementation is committed/pushed to `meta-hackers/fairbuy` on the branch you intend to deploy. Local changes alone are not visible to Render.
- A Render account connected to that GitHub repository, with permission to create resources.
- A Meta Model API key from [dev.meta.ai](https://dev.meta.ai) with billing, access to the configured model (`muse-spark-1.3-contributor`), the Responses API (search grounding) and structured output. Pay-as-you-go Contributor mode is lower cost in exchange for Meta possibly using submitted content to train its models.

## Blueprint

The root `render.yaml` targets the **existing** free-tier resources, not replacement instances:

| Resource | Existing Render ID | Region |
|---|---|---|
| Web service `fairbuy` | `srv-dbj5i5u7bikc73efp0mg` | Virginia |
| PostgreSQL instance `sample-postgres` | `dpg-db5t7n0473hc73cb6vr0-a` | Frankfurt |

The database declaration preserves the instance's existing PostgreSQL 18 version, default database/user, free plan and Virginia outbound IP allowlist. Render allows one free database per workspace; adopting this instance does not require a second database. Do not rename or move the instance as part of adoption.

Do not move the web service to Frankfurt/EU for Meta calls: in testing, Meta Model API returned `404 model_not_found` for both `muse-spark-1.3-contributor` and `muse-spark-1.3` from Frankfurt, while the same key worked from Switzerland and from Render Virginia.

### Administrative adoption of the existing resources

1. Take or verify a backup of the logical database `fairbuy` before changing live infrastructure. Confirm neither resource is already managed by another Blueprint.
2. Push the deployment changes to `https://github.com/meta-hackers/fairbuy`. The service follows the Blueprint branch; there is no hardcoded `main` override.
3. In the Render Dashboard, select the **existing** resources and use **Generate Blueprint**. Follow its instructions for managing those resources with the repository's `render.yaml`, rather than replicating them. Initial Blueprint creation/approval requires the Dashboard; the public API supports validation and updating existing Blueprints but does not expose creation.
4. Review the sync plan before approving it. It must adopt/update the resource IDs above, not create a new web service, a suffixed database, or a replacement instance. If the flow proposes duplicates, stop and use the existing-resource adoption instructions. Do not delete the live resources to resolve a name collision.
5. Preserve the existing `DATABASE_URL`, `MODEL_API_KEY` and `APP_ACCESS_TOKEN` secrets. They use `sync: false`; do not paste their values into Git. If Render prompts for values during initial creation, supply the existing values securely. A later Blueprint sync leaves these variables unchanged.
6. Approve/sync only after confirming the resource identities and unchanged free plans. Verify that both resources appear in the Blueprint's resource list with their original IDs and that `https://fairbuy.onrender.com/healthz` succeeds.
7. Smoke-test live Ask → Configure → Discovery → Learn → Buy using a small request. Check clickable citations and the live/preview banner. Confirm that prices/charges/stock not found in evidence remain unknown. Watch API billing/latency.

Render builds with `npm ci --include=dev && npm run build` and starts with `npm start`. Free web services do not support `preDeployCommand`; instead, the app safely initializes schema at startup before accepting requests. `npm run db:migrate` remains available for explicit maintenance runs. `/healthz` checks database availability, not paid AI access. Without a valid `MODEL_API_KEY`, the app serves setup guidance and never substitutes demo results. `APP_ACCESS_TOKEN` is the fixed app password, not a per-user account.

### Cross-region database connection

The PostgreSQL **instance** is named `sample-postgres`; its default logical database/user are `sample_postgres_baoy` / `sample_postgres_baoy_user`. FairBuy actually connects to a separate logical database named **`fairbuy`** inside that same instance. Preserve the current `DATABASE_URL`, including its `/fairbuy` database path.

For the current cross-region setup (Virginia web, Frankfurt database), use the database **external** connection string with `?sslmode=require`. The Blueprint preserves the two existing Virginia shared outbound ranges in the database IP allowlist. Verify these against Render service → Networking / outbound IPs if the service's networking changes. Do not set `ipAllowList: []`: that would block the cross-region app.

Do **not** replace the secret with `fromDatabase: { name: sample-postgres, property: connectionString }`. Render's `connectionString` property is an internal/private URL that cannot cross regions and points to the instance's default database, not FairBuy's separate logical database. Blueprint-managed infrastructure can still use a manually configured connection secret. Do not disable TLS certificate verification.

Automatic deploys wait for GitHub checks to pass. This repository supplies CI with typechecking, build, PostgreSQL tests, Blueprint validation, dependency audit and mobile/desktop browser tests. On first deploy or if no checks run, use Render’s manual deploy controls as needed.

## Environment

| Variable | Default / purpose |
|---|---|
| `DATABASE_URL` | Secret external PostgreSQL URL to the logical database `fairbuy`, with `sslmode=require` for the current cross-region deployment; mandatory in live/production mode. |
| `MODEL_API_KEY` | Server-only secret; may be configured later without rebuilding frontend assets. |
| `ASK_MODEL` | `muse-spark-1.3-contributor`; question-asking and structured brief. |
| `CONFIGURE_MODEL` | `muse-spark-1.3-contributor`; Configure and Learn interpretation calls. |
| `DISCOVERY_MODEL` | `muse-spark-1.3-contributor`; discovery research and evidence extraction. |
| `REASONING_EFFORT` | `medium`; `minimal`–`xhigh` are valid. `"max"` is not supported by the Contributor model. |
| `SEARCH_PROVIDER` | `meta` (default; no extra search key needed) or `brave`. |
| `BRAVE_API_KEY` | Optional secret only for `SEARCH_PROVIDER=brave`; the Meta key is still required for interpretation/extraction. |
| `APP_ACCESS_TOKEN` | Fixed app password set in Render (`sync: false` in the Blueprint). Local empty value disables gate; not recommended for a public deployment. |
| `APP_ORIGIN` | Optional exact HTTPS public origin for a custom domain, with no trailing slash. Default uses Render’s `RENDER_EXTERNAL_URL`. |
| `FAIRBUY_MODE` | `live`; use `demo` only for an explicitly labelled scripted preview. |
| `NODE_ENV` | `production` on Render: Secure cookies and database requirement. |
| `PORT` | Render-injected listen port; local default 3001. |
| `NODE_VERSION` | Tested/pinned in Blueprint and `.node-version`. |

Use model IDs your account actually supports. Defaults are configurable, not an assurance of account access. Provider errors are intentionally redacted; check model names, credits and provider dashboards. Never put secrets in `VITE_*`, frontend source, URLs or Git.

## Optional Brave search

Add `BRAVE_API_KEY`, change `SEARCH_PROVIDER` to `brave`, and redeploy/restart. This implementation uses Brave Web Search snippets, not full page extraction or CAPTCHA bypassing. Results may be sparse, and unrelated comparison articles are not seller offers. Switch back to `meta` without code changes. Crawlora is not implemented or required.

## Operations and recovery

- Keep **one web instance** until rate limits are backed by shared storage. PostgreSQL claims can coordinate workers across processes, but current abuse limiters are process-local.
- Jobs survive redeploys. A terminated job’s five-minute lease expires; it is reclaimed on a subsequent worker tick. After two interrupted attempts it fails visibly. A provider failure does not automatically burn another call; Refresh queues a new round subject to limits.
- Render gets up to 300 seconds for graceful shutdown; the app waits for active jobs/API calls, then closes PostgreSQL. Abrupt termination still uses lease recovery.
- Database retention: searches are inaccessible after seven days, physically pruned hourly. Current-search deletion cascades to jobs. Configure Render backups/recovery according to your own privacy/reliability policy.
- Free database lifetime is separate from application retention. On November 1, 2026, Render reported this instance expires **November 10, 2026**. Blueprint adoption does not extend that deadline. Arrange a backup and an explicitly approved upgrade or migration before expiry; this Blueprint intentionally does not change billing plans.
- Set Meta Model API/Brave project billing budgets/alerts. Rate limits, output tokens, search tool limits and two concurrent jobs reduce usage but are **not a dollar-denominated spending guarantee**. Rotate `APP_ACCESS_TOKEN` and API keys if exposed.
- Custom domain: set `APP_ORIGIN=https://your-domain.example` exactly. Browser writes from other origins are rejected. API and frontend must stay on the same origin.
- Logs intentionally omit request bodies, chat text and upstream error bodies. Provider failures log only HTTP status, model, provider error code/type/param and request id. Do not add secret/prompt logging during troubleshooting.

## What is not deployed by the code

The Blueprint file describes the existing deployment, but editing/validating it alone does not attach live resources to a Blueprint. Follow the administrative adoption checklist and verify the original resource IDs after syncing. No resources, external transactions or paid provider calls are created during the test suite. Account auth, seller inventory integrations, screenshots/audio, arbitrary crawling and payments are not implemented.
