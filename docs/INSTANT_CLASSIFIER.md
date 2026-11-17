# Instant classifier

## Draft previews

The optional instant classifier shows provisional category, explicit budget, condition and requirement hints after a 600 ms typing pause in Ask. It has no separate reasoning phase, no web search and no fixed price estimates. Nothing updates the brief until the user sends the message to the existing Ask conversation.

The shared “Privacy, evidence & how it works” disclosure explains that unsent drafts go to Cloudflare. Requests are debounced, cancelled when superseded, time-limited and separately rate-limited; failed previews never block Send. The preview shows at most three distinct validated hints, prioritising category, budget with currency and firm/flexible, condition, then requirements. A clarification question can also appear when the draft is ambiguous. Each hint must quote whole words of the draft as evidence; case, accents and spacing may differ, but part of a word never counts. Hints are not confirmed facts or a replacement for the main AI. There is no live classifier or simulated fallback in scripted demo mode. See [architecture](Architecture.md#instant-classifier) for validation, caching and request limits.

## Setup

Add `INSTANT_CLASSIFIER_PROVIDER=cloudflare`, `CLOUDFLARE_ACCOUNT_ID` and a restricted `CLOUDFLARE_API_TOKEN` (Workers AI Read + Edit for that account) to the server's `.env` or Render environment. No Cloudflare Worker, DNS change or browser key is needed. Keep the Free plan if you want requests to stop at its daily allowance rather than charge overages. See [deployment configuration](DEPLOYMENT.md#optional-cloudflare-instant-classifier).

## Model choices

FairBuy uses Cloudflare Workers AI only for the optional, provisional draft preview. The default and only accepted ID is `@cf/meta/llama-3.1-8b-instruct-fp8-fast`. It still responded on November 17, 2026 and accepted the classifier's `response_format: { type: "json_schema", json_schema: ... }` request. The main Ask, Configure, and Discovery models are separate and unchanged.

| Supported `INSTANT_CLASSIFIER_MODEL` | Neurons / 1M input tokens | Neurons / 1M output tokens | Published price / 1M tokens | Use |
| --- | ---: | ---: | --- | --- |
| `@cf/meta/llama-3.1-8b-instruct-fp8-fast` | 4,119 | 34,868 | $0.045 input, $0.384 output | Server default and only allowlisted model. |

Rates are from [Cloudflare Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) (page updated November 12, 2026). A direct request with 58 prompt tokens and 126 completion tokens reported `4.63` neurons. Actual usage depends on input and output length.

### November 2026 deprecation

Cloudflare's [November 5, 2026 changelog](https://developers.cloudflare.com/changelog/post/2026-11-05-planned-model-deprecations/) retires 24 Workers AI models on November 20, 2026, including `@cf/meta/llama-3.1-8b-instruct-fp8`, `@cf/meta/llama-3.2-3b-instruct` and `@cf/meta/llama-3.2-1b-instruct`. They were removed from the allowlist on November 17, 2026. The changelog says retired models will fail with HTTP `410 Gone` and error code `5028`. The fast 8B model above is not on that list and was still returning successful responses on November 17.

Cloudflare's pricing page still lists the fast 8B model's rates, but its individual model documentation page returned 404 and it did not appear in the account's model search results on November 17. It remains the only model measured that day that works with this classifier, so the risk of a later removal is documented in the pull request rather than hidden by switching to an untested replacement.

## Why the older 1B, 3B and non-fast 8B models are gone

The instant classifier requires structured output via `response_format: { type: "json_schema", json_schema: ... }`. Earlier tests on November 1, 2026 found that `@cf/meta/llama-3.2-1b-instruct` rejected that request with HTTP `403`, error code `5025` (`This model doesn't support JSON Schema.`), and returned prose without `response_format`. The 3B and non-fast 8B models accepted the request, but Cloudflare retires them on November 20, 2026.

Removing structured output is not a drop-in fix: the classifier still needs schema validation and exact evidence grounding. Do not bypass those checks. Any alternate model must be tested with the same request contract and must return the parsed JSON in `result.response` before it can enter the allowlist.

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

Results of November 17, 2026, one run each at temperature 0, on the same account and prompt. Candidates were supplied as command-line overrides; the allowlist itself was not widened.

| Model | Available | `json_schema` request | Checks passed | Invented | Dropped | Median latency | Outcome |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| `@cf/meta/llama-3.1-8b-instruct-fp8-fast` | Yes, HTTP 200 | Accepted; JSON returned in `result.response` | **60/69 (87%)** | **0** | **2** | **732 ms** | Keep as default |
| `@cf/google/gemma-4-26b-a4b-it` | Yes, HTTP 200 | Accepted but not honored; response arrived in `choices[0].message`, not `result.response` | 0/0 (all 16 calls failed) | 0 (no valid output) | 0 (no valid output) | - | Reject |
| `@cf/qwen/qwen3.8-27b` | Yes, HTTP 200 | Accepted but not honored; response arrived in `choices[0].message`, not `result.response` | 0/0 (all 16 calls failed) | 0 (no valid output) | 0 (no valid output) | - | Reject |
| `@cf/deepseek-ai/deepseek-v4.1-flash-1017` | No; HTTP 403, error `5035`, requires Workers Paid | Not reached | 0/0 (all 16 calls failed) | 0 (no valid output) | 0 (no valid output) | - | Reject |

The gemma and qwen models did not return error `5025`, so they do not reject the schema outright. They returned an OpenAI-style `choices` payload with no `result.response`, spent output tokens on reasoning, and did not stay inside the schema. Fifteen of the sixteen eval calls hit the classifier's 8-second timeout and one returned unparseable data. Direct probes took roughly 7 to 12 seconds with a 600-token cap; raising the cap to 2,000 took about 34 to 36 seconds and still did not produce the classifier's response shape. The DeepSeek model is listed as requiring Workers Paid, so it could not be evaluated on this account without changing billing. Published rates are $0.10/$0.30 per million input/output tokens for gemma (`9,091`/`27,273` neurons), $0.45/$3.20 for qwen (`40,909`/`290,909` neurons) and $0.30/$1.20 for DeepSeek (`27,273`/`109,091` neurons). None is usable here without a code path that the repo does not have.

A final single-model rerun after the code change repeated 60/69 (87%), 0 invented, 2 dropped and a median of 713 ms.

Earlier November 2, 2026 findings still explain the prompt and grounding:

- **Translated labels:** the models translated labels into English ("Laptop" for *portatile*, "Washing machine" for *Waschmaschine*). Grounding then dropped them, because the label shared no word with its quote. The prompt now asks for labels in the draft's own language.
- **Examples read as chat history:** the few-shot examples were sent as earlier chat turns, so the model answered "laptop" with "You previously mentioned you do not want a laptop". The examples are now part of the system prompt, labelled as separate drafts.
- **Missing currency:** both models often left the currency empty for "500 euro" or "400 €". Grounding now fills it only when the budget quote names exactly one currency unmistakably; `$` and `¥` alone stay empty.

**Recommendation:** keep `@cf/meta/llama-3.1-8b-instruct-fp8-fast` as the default and the only allowlisted ID. It passed the most checks, invented nothing and lost little to grounding. The three suggested replacements either do not return the classifier's response shape, exceed the preview timeout or require a paid Workers plan. Widening the allowlist to them would have made configuration valid while every preview failed.

Remaining 8B misses are mostly requirements folded into the category ("Windows laptop", "Bici da corsa in carbonio"), some sizes it did not extract, and a clarification instead of a category for the one-word draft "laptop". A single run per model is a small sample: rerun the script after any prompt or model change.

## Applying model changes

To enable the preview, set `INSTANT_CLASSIFIER_PROVIDER=cloudflare` and provide server-only `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. `INSTANT_CLASSIFIER_MODEL` must be `@cf/meta/llama-3.1-8b-instruct-fp8-fast`; the server refuses to start if a retired ID is still configured. Don't put credentials in frontend variables. The existing Render service environment and `.env.example` already select the fast 8B model. Manage production values directly on the Render service. See [deployment configuration](DEPLOYMENT.md#optional-cloudflare-instant-classifier).

Model settings are currently read at application startup. Updating a Render environment variable requires a restart/redeploy and takes effect only when the new instance is live; hot reload or a database-backed runtime override is not implemented.
