# Offline fallback illustrations

The 300 WebP images in `frontend/public/illustrations/` are AI-generated generic
product-type artwork, **not photos of listings**. Real seller images and image
recovery always take precedence. When neither works, the frontend selects local
art using whole-word product category/name aliases, with a generic parcel as the
default. Every size displays **AI illustration · not a product photo**. If a
static asset fails to load, the inline SVG glyph remains the final fallback.

No image generation happens at runtime. No product, seller or user data is sent
for generation. No database schema or `imageUrl` evidence fields are changed.
Existing saved searches benefit immediately after deployment.

## Regenerating

- Catalog: `frontend/src/product-illustrations.json` (slug, generic subject, aliases).
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
