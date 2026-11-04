# FairBuy

**Find what fits. Choose the best purchase, not just the lowest price.**

FairBuy is an AI shopping research application: describe what you need, refine your preferences, and compare source-backed products and seller offers. It helps you research a purchase; it does not handle checkout or payments. See the [shopping flow](docs/Flow.md).

Built with React, TypeScript/Express, shared Zod contracts and PostgreSQL, using Meta Model API for conversations and web research. Cloudflare draft previews and Brave search are optional. It combines [Alberto’s demo](https://github.com/meta-hackers/fairbuy-alberto-demo) and [Alessandro’s demo](https://github.com/meta-hackers/fairbuy-alessandro-demo).

## Quick start

Use Node **24.22.1** (`.node-version`):

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

Open **http://localhost:5173**. See [local development](docs/DEVELOPMENT.md) for a no-key demo, builds and tests.

## Important limits

AI extraction is not independent verification; prices, stock and seller claims may be stale or incomplete. Prices exclude shipping, and market coverage is not guaranteed. Avoid sensitive information and review provider data-use policies and billing limits before live use.

## Documentation

- [Shopping flow](docs/Flow.md)
- [Architecture and AI session lifecycle](docs/Architecture.md)
- [Instant classifier setup and model limitations](docs/INSTANT_CLASSIFIER.md)
- [Local development, demo and testing](docs/DEVELOPMENT.md)
- [Render deployment and operations](docs/DEPLOYMENT.md)
- [Browser errors and image diagnostics](docs/CLIENT_DIAGNOSTICS.md)
- [Offline fallback illustrations](docs/ILLUSTRATIONS.md)
- [API routes](docs/API.md)
- [Discovery policy and stopping rules](docs/DISCOVERY_POLICY.md)
- [Category-aware source hints](docs/SOURCES.md)
- [Source catalog repository](https://github.com/meta-hackers/fairbuy-sources-catalog) · [published catalog](https://meta-hackers.github.io/fairbuy-sources-catalog/)
- [Backoffice administration](docs/BACKOFFICE.md)
- [Demo integration notes](docs/INTEGRATION.md)
- [Backend](backend/README.md) · [Frontend](frontend/README.md) · [Certificates](certs/README.md)
- [Maintainer TODO](docs/TODO.md) · [Original proposal](docs/PROPOSAL.md) (historical)
