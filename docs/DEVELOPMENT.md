# Local development and verification

Run all commands from the repository root. The live application requires PostgreSQL and a `MODEL_API_KEY`; Meta hosted web search is the default, so Brave is optional. See the [shopping flow](Flow.md) and [architecture](Architecture.md) for application behavior.

## Run locally

Node **24.22.1** is the tested runtime ([`.node-version`](../.node-version)).

```bash
npm ci
cp .env.example .env
docker compose up -d
```

Set `MODEL_API_KEY` in `.env`, then:

```bash
npm run db:migrate
npm run dev
```

Open **http://localhost:5173**. Discovery starts with the bundled catalog fallback. To load the published catalog, set `CATALOG_URL`/`CATALOG_SYNC_ON_START` or use **Backoffice → Sources → Sync from GitHub** on the backend port. Vite proxies the API to `PORT` from the root `.env` or process environment, falling back to port 4000. The example database password is for local development only.

### Optional instant classifier

See [instant classifier setup and model limitations](INSTANT_CLASSIFIER.md). This feature is optional and separate from the main Meta API configuration.

### No-key preview

```bash
npm ci
FAIRBUY_MODE=demo DATABASE_URL= npm run dev
```

This explicitly uses a **scripted assistant and invented laptop catalog**, prominently labelled in the UI. Try “A laptop for coding”, then “Italy, budget €700”. There is no live AI, current offer or functional seller link in demo mode. Without PostgreSQL, preview data is lost on server restart. Live mode never silently falls back to fixtures.

### Build and verify

```bash
npm run build
npm test
npm run check:blueprint
npx playwright install chromium
npm run test:e2e
npm audit
```

To include database integration tests, set `TEST_DATABASE_URL` to a **dedicated test PostgreSQL database**. CI does this automatically. Browser tests run the compiled full stack in explicit demo mode on desktop and 390/320 px mobile viewports. API/provider tests use controlled HTTP mocks, not paid calls.

For a production-style local server, `npm run build && npm start` serves everything on `PORT` from `.env` or the process environment, falling back to port 4000.

## Deploy on Render

See [deployment instructions and environment variables](DEPLOYMENT.md). Reuse the existing Virginia service in Render's **My Workspace** and the Supabase database; do not provision duplicate services or a Render database.

## Trust and limitations

- Every live offer links to a provider-returned source, includes retrieved time and retains evidence. AI extraction is **not independent verification**; search snippets may be stale or incomplete.
- Prices are the seller’s final listed product prices, not delivered totals. Location-dependent shipping/delivery is not estimated or added. Unknown prices, stock, compatibility and warranty remain unknown; no exchange rates are invented.
- No arbitrary URL crawler, payment, booking, seller-message or order endpoint exists. Meta Model API, optional Cloudflare classification and Brave calls use fixed provider endpoints.
- Anonymous, cookie-isolated searches have no automatic expiry. “New search” appends an archive version; history remains in the backoffice until explicit maintenance deletion. Owner cookies last seven days; there is no login or cross-device recovery. Avoid sensitive personal information.
- There are bounded model calls, job concurrency and rate limits, but configure provider billing limits too. There is no promise of exhaustive market coverage or guaranteed savings.
- Live integration code is implemented and tested with mocked provider responses. **Actual Meta Model API/model/web-search access must be checked with your key after deployment.** Contributor mode pricing means Meta may use submitted content to train its models; prefer non-sensitive data and configure billing limits. Automated tests do not create cloud resources.

For the documentation index, see the [project README](../README.md). Package-specific commands are in the [backend](../backend/README.md) and [frontend](../frontend/README.md) READMEs.
