# Frontend

React + Vite, adapting Alberto’s focused flow and visual language to the shared contract and persistent backend.

**Ask → Configure → Discovery ↔ Learn → Buy**

The browser calls only same-origin `/api` routes. During development Vite proxies them to port 3001. In production the Render API serves the built SPA; GitHub Pages is not needed. No provider credentials belong in this package or any `VITE_*` variable.

Learn is a native accessible dialog over Discovery. It supports product rejection or general feedback. A new queued search carries previous results and the entire active feedback log. Buy only opens source-backed external seller pages; it does not purchase.

See [setup](../README.md) and the desktop/mobile [browser tests](../e2e/shopping.spec.ts).
