# Instant classifier

## Draft previews

The optional instant classifier shows provisional category, explicit budget, condition and requirement hints after a 600 ms typing pause in Ask. It has no separate reasoning phase, no web search and no fixed price estimates. Nothing updates the brief until the user sends the message to the existing Ask conversation.

The UI discloses that unsent drafts go to Cloudflare. Requests are debounced, cancelled when superseded, time-limited and separately rate-limited; failed previews never block Send. Hints require exact input evidence and are not confirmed facts or a replacement for the main AI. There is no live classifier or simulated fallback in scripted demo mode. See [architecture](Architecture.md#instant-classifier) for validation, caching and request limits.

## Setup

Add `INSTANT_CLASSIFIER_PROVIDER=cloudflare`, `CLOUDFLARE_ACCOUNT_ID` and a restricted `CLOUDFLARE_API_TOKEN` (Workers AI Read + Edit for that account) to the server's `.env` or Render environment. No Cloudflare Worker, DNS change or browser key is needed. Keep the Free plan if you want requests to stop at its daily allowance rather than charge overages. See [deployment configuration](DEPLOYMENT.md#optional-cloudflare-instant-classifier).

## Model choices

FairBuy uses Cloudflare Workers AI only for the optional, provisional draft preview. The default is `@cf/meta/llama-3.2-3b-instruct`. The 1B model is not supported: Cloudflare rejects its JSON Schema requests with error `5025`. The main Ask, Configure, and Discovery models are separate and unchanged.

| Supported `INSTANT_CLASSIFIER_MODEL` | Neurons / 1M input tokens | Neurons / 1M output tokens | Use |
| --- | ---: | ---: | --- |
| `@cf/meta/llama-3.2-3b-instruct` | 4,625 | 30,475 | Default; supports the classifier's JSON Schema requests. |
| `@cf/meta/llama-3.1-8b-instruct-fp8-fast` | 4,119 | 34,868 | Alternative: fewer input neurons than 3B, more output neurons. |

Rates are from [Cloudflare Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) (October 2026); check the current rates before comparing costs. Actual usage depends on input and output length. Test classification quality with representative drafts before choosing another model.

## Why the 1B model cannot be used

The instant classifier requires structured output via `response_format: { type: "json_schema", json_schema: ... }`. Direct API tests on November 1, 2026 confirmed these constraints for `@cf/meta/llama-3.2-1b-instruct`:

- With JSON Schema, Cloudflare returns HTTP `403`, error code `5025`: `This model doesn't support JSON Schema.` This is a model/request incompatibility, not an authentication failure or exhausted quota.
- Without `response_format`, the model responds successfully (HTTP `200`), but the test returned prose and a Markdown code block rather than a strict JSON response. Prompting for JSON alone does not enforce the classifier's schema.
- Removing structured output is not a drop-in fix: the classifier still needs schema validation and exact evidence grounding. Do not bypass those checks to accommodate 1B.

The 1B model is therefore excluded from the configuration allowlist despite its lower neuron cost. Use the default 3B model, which passed a live test with the full classifier request and validation. Any alternative must be tested with that same request contract before deployment.

## Applying model changes

To enable the preview, set `INSTANT_CLASSIFIER_PROVIDER=cloudflare` and provide server-only `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. Set `INSTANT_CLASSIFIER_MODEL` to one of the IDs above to override the default in the server's `.env` or the Render service environment; don't put credentials in frontend variables. The Render blueprint and `.env.example` select 3B. An existing Render environment value can override the blueprint, so update it to 3B when deploying this choice. See [deployment configuration](DEPLOYMENT.md#optional-cloudflare-instant-classifier).

Model settings are currently read at application startup. Updating a Render environment variable requires a restart/redeploy and takes effect only when the new instance is live; hot reload or a database-backed runtime override is not implemented.
