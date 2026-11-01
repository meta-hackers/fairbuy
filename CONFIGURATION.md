# Instant classifier model configuration

FairBuy uses Cloudflare Workers AI only for the optional, provisional draft preview. The default is `@cf/meta/llama-3.2-1b-instruct`, chosen because it uses the fewest neurons of the supported models for both input and output. The main Ask, Configure, and Discovery models are separate and unchanged.

| Supported `INSTANT_CLASSIFIER_MODEL` | Neurons / 1M input tokens | Neurons / 1M output tokens | Use |
| --- | ---: | ---: | --- |
| `@cf/meta/llama-3.2-1b-instruct` | 2,457 | 18,252 | Default; lowest neuron usage. |
| `@cf/meta/llama-3.2-3b-instruct` | 4,625 | 30,475 | Alternative if 1B preview quality is insufficient. |
| `@cf/meta/llama-3.1-8b-instruct-fp8-fast` | 4,119 | 34,868 | Alternative: fewer input neurons than 3B, more output neurons. |

Rates are from [Cloudflare Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) (October 2026); check the current rates before comparing costs. Actual usage depends on input and output length. Test classification quality with representative drafts before choosing another model.

To enable the preview, set `INSTANT_CLASSIFIER_PROVIDER=cloudflare` and provide server-only `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. Set `INSTANT_CLASSIFIER_MODEL` to one of the IDs above to override the default in the server's `.env` or the Render service environment; don't put credentials in frontend variables. The Render blueprint and `.env.example` select 1B. An existing Render environment value can override the blueprint, so update it to 1B when deploying this choice. See [deployment configuration](docs/DEPLOYMENT.md#optional-cloudflare-instant-classifier).
