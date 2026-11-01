# FairBuy

**Find what fits. Choose the best purchase, not just the lowest price.**

A full-stack AI shopping research application combining [Alberto’s demo](https://github.com/meta-hackers/fairbuy-alberto-demo) and [Alessandro’s demo](https://github.com/meta-hackers/fairbuy-alessandro-demo).

## Ask → Configure → Discovery ↔ Learn → Buy

- **Ask:** a real AI conversation collects enough context to search, asking useful follow-ups rather than enforcing a fixed number of answers.
- **Instant classifier (optional):** Cloudflare-hosted Meta Llama shows provisional category, explicit budget, condition and requirement hints after a 600 ms typing pause in Ask. It has no separate reasoning phase, no web search and no fixed price estimates. Nothing updates the brief until you send the message to the existing Ask conversation.
- **Configure:** edit the extracted brief, budget, country and soft preferences/must-haves. A separate smaller AI helps incorporate extra requirements.
- **Discovery:** a new AI session researches products on the web, extracts source-backed offers and explains fit and trade-offs. Deterministic rules handle hard constraints and numerical ranking.
- **Learn:** reject a product or add feedback. Every submission starts fresh discovery with the original configuration, current brief, all prior products, discarded products and accumulated feedback. Undo preserves unrelated edits and starts another search.
- **Buy:** inspect the chosen product’s seller offers and visit a source page yourself. **No automatic checkout or payment.**

On page load, FairBuy requests browser location permission (HTTPS or localhost required). With permission, a rounded position is reverse-geocoded via OpenStreetMap Nominatim to suggest the city, country and supported local currency (EUR, CHF, USD or GBP). Other local currencies require a manual supported-currency choice; no conversion is assumed. Denied/unavailable location never blocks shopping. The location bar and Configure remain editable, and automatic detection never replaces an existing shopping country. No geocoding key is needed; only city/country/currency enter the shopping brief, not precise coordinates or a street address.

React/Vite frontend, TypeScript/Express backend, shared Zod contracts, PostgreSQL session storage and a durable leased job queue. Meta Model API (Muse Spark 1.3, Contributor mode) is called through its REST Responses API. By default its hosted web search means **only a `MODEL_API_KEY` is needed**; Brave is optional.

## Run locally

Node **24.22.1** is the tested runtime (`.node-version`).

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

Open **http://localhost:5173**. Vite proxies the API to port 3001. The example database password is for local development only.

### Optional instant classifier

Add `INSTANT_CLASSIFIER_PROVIDER=cloudflare`, `CLOUDFLARE_ACCOUNT_ID` and a restricted `CLOUDFLARE_API_TOKEN` (Workers AI Read + Edit for that account) to the server's `.env` or Render environment. The default model is `@cf/meta/llama-3.2-3b-instruct`; `INSTANT_CLASSIFIER_MODEL` can select the supported 1B or 8B-fast alternative. No Cloudflare Worker, DNS change or browser key is needed. Keep the Free plan if you want requests to stop at its daily allowance rather than charge overages.

The UI discloses that unsent drafts go to Cloudflare. Requests are debounced, cancelled when superseded, time-limited and separately rate-limited; failed previews never block Send. Hints require exact input evidence and are not confirmed facts or a replacement for the main AI. There is no live classifier or simulated fallback in scripted demo mode. See [deployment configuration](docs/DEPLOYMENT.md#optional-cloudflare-instant-classifier).

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

For a production-style local server, `npm run build && npm start` serves everything on port 3001 using `.env`.

## Deploy on Render

The root [`render.yaml`](render.yaml) defines the `fairbuy` project and `production` environment in Render's **My Workspace**, with one free web service in **Virginia** at [fairbuy.onrender.com](https://fairbuy.onrender.com). PostgreSQL is hosted by **Supabase**, not Render. The backend uses a dedicated database login, a private `fairbuy` schema and a verified-TLS Session pooler connection stored in `DATABASE_URL`. Meta Model API calls require the Virginia service (Frankfurt returned `model_not_found`). Review provider pricing before changing plans.

1. Push this implementation to `git@github.com:meta-hackers/fairbuy.git`.
2. Set up the private Supabase schema using the [deployment instructions](docs/DEPLOYMENT.md#supabase-postgresql).
3. Select **My Workspace** in Render and reuse its existing **fairbuy** Blueprint and service. Do not recreate them or create a duplicate in the separate `fairbuy` workspace. Supply the Supabase `DATABASE_URL` and `MODEL_API_KEY` as server-only secrets. No key is bundled in the frontend. Without a model key, health checks still work and the UI explains setup.
4. Set `APP_ACCESS_TOKEN` in Render to a fixed app password you choose, then enter that password in the app. This gate protects your AI credits.

The Blueprint declares the Render project, environment, build, startup and health checks; it deliberately contains no Render database. Supabase is managed separately. Initial attachment/sync in Render is still required; committing YAML alone does not make resources Blueprint-managed. See [deployment instructions and environment variables](docs/DEPLOYMENT.md).

## Trust and limitations

- Every live offer links to a provider-returned source, includes retrieved time and retains evidence. AI extraction is **not independent verification**; search snippets may be stale or incomplete.
- Unknown shipping, taxes, stock, compatibility and warranty remain unknown. An incomplete cost is a known minimum, not a delivered price. No exchange rates are invented.
- No arbitrary URL crawler, payment, booking, seller-message or order endpoint exists. Meta Model API, optional Cloudflare classification and Brave calls use fixed provider endpoints.
- Anonymous, cookie-isolated searches expire after **7 days**. “New search” deletes the active search. There is no login or cross-device recovery. Avoid sensitive personal information.
- There are bounded model calls, job concurrency and rate limits, but configure provider billing limits too. There is no promise of exhaustive market coverage or guaranteed savings.
- Live integration code is implemented and tested with mocked provider responses. **Actual Meta Model API/model/web-search access must be checked with your key after deployment.** Contributor mode pricing means Meta may use submitted content to train its models; prefer non-sensitive data and configure billing limits. Automated tests do not create cloud resources.

## Documentation

- [Architecture and AI session lifecycle](Architecture.md)
- [Render deployment and operations](docs/DEPLOYMENT.md)
- [API routes](docs/API.md)
- [Demo integration notes](docs/INTEGRATION.md)
- [Original product proposal](docs/PROPOSAL.md) — historical planning; not a statement of current integrations or event eligibility.
