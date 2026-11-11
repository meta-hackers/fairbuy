# Instant classifier

## Draft previews

The optional instant classifier shows provisional category, explicit budget, condition and requirement hints after a 600 ms typing pause in Ask. It has no separate reasoning phase, no web search and no fixed price estimates. Nothing updates the brief until the user sends the message to the existing Ask conversation.

The shared “Privacy, evidence & how it works” disclosure explains that unsent drafts go to Cloudflare. Requests are debounced, cancelled when superseded, time-limited and separately rate-limited; failed previews never block Send. The preview shows at most three distinct validated hints, prioritising category, budget with currency and firm/flexible, condition, then requirements. A clarification question can also appear when the draft is ambiguous. Each hint must quote whole words of the draft as evidence; case, accents and spacing may differ, but part of a word never counts. Hints are not confirmed facts or a replacement for the main AI. There is no live classifier or simulated fallback in scripted demo mode. See [architecture](Architecture.md#instant-classifier) for validation, caching and request limits.

## Setup

Add `INSTANT_CLASSIFIER_PROVIDER=cloudflare`, `CLOUDFLARE_ACCOUNT_ID` and a restricted `CLOUDFLARE_API_TOKEN` (Workers AI Read + Edit for that account) to the server's `.env` or Render environment. No Cloudflare Worker, DNS change or browser key is needed. Keep the Free plan if you want requests to stop at its daily allowance rather than charge overages. See [deployment configuration](DEPLOYMENT.md#optional-cloudflare-instant-classifier).

## Model choices

FairBuy uses Cloudflare Workers AI only for the optional, provisional draft preview. The default is `@cf/meta/llama-3.1-8b-instruct-fp8-fast`. The 1B model is not supported: Cloudflare rejects its JSON Schema requests with error `5025`. The main Ask, Configure, and Discovery models are separate and unchanged.

| Supported `INSTANT_CLASSIFIER_MODEL` | Neurons / 1M input tokens | Neurons / 1M output tokens | Use |
| --- | ---: | ---: | --- |
| `@cf/meta/llama-3.1-8b-instruct-fp8-fast` | 4,119 | 34,868 | Server default: faster 8B classifier; fewer input neurons than 3B, more output neurons. |
| `@cf/meta/llama-3.1-8b-instruct-fp8` | 13,778 | 26,128 | Alternative: more input neurons, fewer output neurons than the fast variant; supports the classifier's JSON Schema requests. |
| `@cf/meta/llama-3.2-3b-instruct` | 4,625 | 30,475 | Fallback; supports the classifier's JSON Schema requests. |

Rates are from [Cloudflare Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) (October 2026); check the current rates before comparing costs. Actual usage depends on input and output length. Test classification quality with representative drafts before choosing another model.

## Why the 1B model cannot be used

The instant classifier requires structured output via `response_format: { type: "json_schema", json_schema: ... }`. Direct API tests on November 1, 2026 confirmed these constraints for `@cf/meta/llama-3.2-1b-instruct`:

- With JSON Schema, Cloudflare returns HTTP `403`, error code `5025`: `This model doesn't support JSON Schema.` This is a model/request incompatibility, not an authentication failure or exhausted quota.
- Without `response_format`, the model responds successfully (HTTP `200`), but the test returned prose and a Markdown code block rather than a strict JSON response. Prompting for JSON alone does not enforce the classifier's schema.
- Removing structured output is not a drop-in fix: the classifier still needs schema validation and exact evidence grounding. Do not bypass those checks to accommodate 1B.

The 1B model is therefore excluded from the configuration allowlist despite its lower neuron cost. Use the default 8B model. Any alternative must be tested with that same request contract before deployment.

## Evaluation

[`backend/eval/instant-classifier.eval.ts`](../backend/eval/instant-classifier.eval.ts) runs 16 fixed synthetic drafts against the live models. The drafts are in English, Italian, German, French and Spanish, and cover:

- laptops, washing machines, watches with a reference number, a bike, shoes, a phone, a tablet and a vacuum;
- negation and alternatives;
- one-word ambiguous drafts.

The script scores 69 expected checks per model: category, amount, currency, firm/flexible budget, condition, expected requirements and clarification. It also counts:

- **invented** hints: a field returned where none was expected;
- **dropped** hints: model output removed by evidence grounding.

It calls Cloudflare with the server credentials and is not part of `npm test`:

```bash
node --env-file=.env --import tsx backend/eval/instant-classifier.eval.ts [model...]
```

Set `EVAL_VERBOSE=1` to print the raw model output for each failed draft.

Results of November 2, 2026, one run each at temperature 0:

| Model | Prompt | Checks passed | Invented | Dropped by grounding | Median latency |
| --- | --- | ---: | ---: | ---: | ---: |
| `@cf/meta/llama-3.1-8b-instruct-fp8-fast` | before | 53/69 (77%) | 0 | 12 | 1,120 ms |
| `@cf/meta/llama-3.2-3b-instruct` | before | 49/68 (72%) | 1 | 9 | 673 ms |
| `@cf/meta/llama-3.1-8b-instruct-fp8-fast` | after | **60/69 (87%)** | **0** | **2** | 746 ms |
| `@cf/meta/llama-3.2-3b-instruct` | after | 57/69 (83%) | 1 | 11 | 811 ms |

Findings that changed the prompt and grounding:

- **Translated labels:** the models translated labels into English ("Laptop" for *portatile*, "Washing machine" for *Waschmaschine*). Grounding then dropped them, because the label shared no word with its quote. The prompt now asks for labels in the draft's own language.
- **Examples read as chat history:** the few-shot examples were sent as earlier chat turns, so the model answered "laptop" with "You previously mentioned you do not want a laptop". The examples are now part of the system prompt, labelled as separate drafts.
- **Missing currency:** both models often left the currency empty for "500 euro" or "400 €". Grounding now fills it only when the budget quote names exactly one currency unmistakably; `$` and `¥` alone stay empty.

**Recommendation:** keep the 8B fast model as the default. It passed more checks, invented nothing, and lost almost nothing to grounding. The 3B model still translates labels and invented a category for "something for my kitchen".

Remaining 8B misses are mostly requirements folded into the category ("Windows laptop", "Bici da corsa in carbonio"), some sizes it did not extract, and a clarification instead of a category for the one-word draft "laptop". A single run per model is a small sample: rerun the script after any prompt or model change.

## Applying model changes

To enable the preview, set `INSTANT_CLASSIFIER_PROVIDER=cloudflare` and provide server-only `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. Set `INSTANT_CLASSIFIER_MODEL` to one of the IDs above to override the default in the server's `.env` or the Render service environment; don't put credentials in frontend variables. The existing Render service environment and `.env.example` select the fast 8B model. Manage production values directly on the Render service. See [deployment configuration](DEPLOYMENT.md#optional-cloudflare-instant-classifier).

Model settings are currently read at application startup. Updating a Render environment variable requires a restart/redeploy and takes effect only when the new instance is live; hot reload or a database-backed runtime override is not implemented.
