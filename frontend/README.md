# Frontend

React + Vite, adapting Alberto’s focused flow and visual language to the shared contract and persistent backend.

**Ask → Configure → Discovery ↔ Learn → Buy**

The browser calls only same-origin `/api` routes. During development Vite proxies them to `PORT` from the root `.env` or process environment (default 4000). In production the Render API serves the built SPA; GitHub Pages is not needed. No provider credentials belong in this package or any `VITE_*` variable.

Learn is a native accessible dialog over Discovery. It supports product rejection or general feedback. A new queued search carries previous results and the entire active feedback log. Buy opens source-backed external seller pages and, on arrival, shows a spinner in the next seller slot while a same-market search looks for additional sellers of the exact chosen model; it does not purchase.

See [setup](../README.md) and the desktop/mobile [browser tests](../e2e/shopping.spec.ts).
