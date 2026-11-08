# Offline fallback illustrations

The 300 WebP images in `frontend/public/illustrations/` are AI-generated generic
product-type artwork, **not photos of listings**. Real seller images and image
recovery always take precedence. When neither works, the frontend selects local
art using whole-word product category/name aliases, with a generic parcel as the
default. Product cards use the offer category, falling back to the saved search
category when absent; watch aliases include plural and spaced forms such as
“watches” and “wrist watches.” The image caption is omitted; the footer’s Product
images disclosure explains that fallback artwork is not a listing photo. If a
static asset fails to load, an inline SVG glyph remains the final fallback,
including a watch-shaped glyph for watches.

No image generation happens at runtime. No product, seller or user data is sent
for image generation. No database schema or `imageUrl` evidence fields are changed.
Existing saved searches benefit from alias improvements immediately after deployment.

## Optional Cloudflare artwork classifier

When local category/name aliases select `generic`, live discovery can send just
the product name (up to 300 characters) and category (up to 100 characters) to
Cloudflare Workers AI to choose one of the 300 existing artwork IDs. It never
receives chat, location, seller URLs or search history. The entire response must
be a JSON object containing only `illustration`, with an allowed ID. Invalid
IDs, URLs, extra fields and reasoning text are rejected. The frontend validates
the saved ID too and always prefers deterministic matches and real photos.

Set `ILLUSTRATION_CLASSIFIER_PROVIDER=cloudflare` and the existing server-only
`CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN`. The app defaults to disabled;
the Render Blueprint enables the provider but credentials are still required.
Demo mode never calls Cloudflare.

`ILLUSTRATION_CLASSIFIER_MODEL` defaults to
`@cf/ibm-granite/granite-4.0-h-micro`. Set it in Render → fairbuy → Environment
to switch to another account-accessible Workers AI text/chat model supporting
the standard `messages`, `response_format: { type: "json_object" }`, `temperature`
and `max_tokens` parameters. This is not an arbitrary provider URL or a promise
that every Cloudflare model is compatible. Use non-reasoning models; the adapter
requests only the ID (64 output tokens, temperature zero), not thinking or tools.
Blueprint sync preserves this operator-managed model value. Save/redeploy to
apply model changes; changing it does not change Ask or Instant classification.

Choices include the actual model ID and persist in immutable product snapshots,
so reloads and Buy reuse them without classification calls. Existing searches
are not backfilled by rendering; a fresh discovery uses the current model.
Duplicate calls are coalesced. A session-isolated, hashed memory cache holds up
to 500 choices for 24 hours (failures for five minutes). Caches and call limits
reset on restart; persisted choices do not. Each call has a three-second timeout,
no retries, two concurrent requests per enrichment and four process-wide, and
at most 1,000 calls per rolling process-local day. Limits or failures leave the
deterministic/generic fallback and never fail discovery. API calls happen outside
retryable database mutations. Usage is recorded as `illustration_classification`;
configure `AI_PRICE_TABLE` with the chosen model’s current rates for accurate cost
estimates. These caps are not a provider-wide dollar spending guarantee.

## Regenerating

- Shared catalog: `packages/core/src/product-illustrations.json` (slug, generic subject, aliases).
- Generator: `scripts/generate-illustrations.py`; Python 3 and Pillow required.
- First 150 types: Cloudflare Workers AI `@cf/black-forest-labs/flux-1-schnell`, four steps.
- Additional 150 types: Meta Model API `muse-image-1.0`, low reasoning, single-shot
  image generation. Web search, image search and shell tools are disabled: the
  illustrations use only generic subject prompts, not listing references.
- Prompts, model, generation timestamps and output SHA-256 hashes are recorded in
  `frontend/public/illustrations/provenance.json`.
- Export `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, then run
  `python scripts/generate-illustrations.py --limit 150`. This makes billable
  provider calls. Keep credentials server-side and out of the asset directory.
- For Meta, export `MODEL_API_KEY` and run
  `python scripts/generate-illustrations.py --provider meta --limit 150 --workers 3`.
  Meta documents a flat $0.01 per generated image (check current pricing before
  running). This tool does not make changes to runtime app configuration.
- Existing assets are skipped regardless of provider. `--limit 1` creates at most
  one missing asset for review before a batch. Generation is sequential by
  default; `--workers 1` through `4` bounds concurrency. Transient HTTP failures
  are retried at most twice; rerunning resumes missing assets. Provenance updates
  are serialized and atomically replaced even during parallel generation.
- Use `--only camera-lens,soundbar --replace` to deliberately regenerate selected
  assets; `--replace` without `--only` is rejected. Outputs are
  nondeterministic; committed assets, not regeneration, ensure a fixed visual set.
- Output is resized to 384×384 WebP. Review artwork before publishing; the
  provider does not guarantee geometric or product accuracy. Provider terms:
  https://developers.cloudflare.com/workers-ai/models/flux-1-schnell/
  and https://dev.meta.ai/docs/image-generation
