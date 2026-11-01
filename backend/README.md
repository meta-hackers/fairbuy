# Backend

Express + TypeScript API, PostgreSQL persistence and leased discovery worker. Live interpretation and research use the Meta Model API Responses **REST API**, not client-side keywords or demo fixtures.

- [`src/ai/`](src/ai/): separate prompts/models for Ask, Configure and fresh Discovery; optional Brave search; validated evidence extraction.
- [`src/shopping-service.ts`](src/shopping-service.ts): state transitions, immutable search context, Learn/Undo and deterministic ranking.
- [`src/store.ts`](src/store.ts): PostgreSQL ownership, transactions, job leases and seven-day retention. Memory storage is demo/test only.
- [`src/app.ts`](src/app.ts): authenticated anonymous-owner API, optional access gate, validation, security headers and throttles.

Run commands from the repository root. See [local setup](../README.md), [API](../docs/API.md), [architecture](../docs/Architecture.md) and [deployment](../docs/DEPLOYMENT.md).
