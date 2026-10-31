import { z } from 'zod';
import type { Settings } from '../settings';
import { AppError } from '../errors';
import { safeUrl } from '../links';
import type { Source } from '@fairbuy/core';

const ResponseSchema = z.object({
  status: z.string(),
  output: z.array(z.object({
    type: z.string(), status: z.string().optional(),
    action: z.object({ sources: z.array(z.object({ url: z.string(), title: z.string().optional() })).optional() }).passthrough().optional(),
    results: z.array(z.object({ type: z.string().optional(), url: z.string(), title: z.string().optional(), snippet: z.string().optional() }).passthrough()).optional(),
    content: z.array(z.object({
      type: z.string(), text: z.string().optional(),
      annotations: z.array(z.object({ type: z.string(), url: z.string().optional(), title: z.string().optional() }).passthrough()).optional(),
    }).passthrough()).optional(),
  }).passthrough()),
});
export interface Research { text: string; sources: Source[] }
export class MetaClient {
  constructor(private config: Settings, private fetcher: typeof fetch = fetch) {}
  ensureConfigured() {
    if (!this.config.MODEL_API_KEY) throw new AppError(503, 'Add MODEL_API_KEY in Render to enable the AI assistant. No demo results have been substituted.', 'AI_NOT_CONFIGURED');
    if (this.config.SEARCH_PROVIDER === 'brave' && !this.config.BRAVE_API_KEY) throw new AppError(503, 'Add BRAVE_API_KEY or set SEARCH_PROVIDER=meta.', 'SEARCH_NOT_CONFIGURED');
  }
  async response(model: string, instructions: string, input: unknown, extra: Record<string, unknown> = {}) {
    this.ensureConfigured();
    let response: Response;
    try {
      response = await this.fetcher('https://api.meta.ai/v1/responses', {
        method: 'POST', headers: { 'Authorization': `Bearer ${this.config.MODEL_API_KEY}`, 'Content-Type': 'application/json' },
        // Reasoning tokens share this budget; keep it above the largest structured result.
        body: JSON.stringify({ model, instructions, input: JSON.stringify(input), store: false, max_output_tokens: 10000, reasoning: { effort: this.config.REASONING_EFFORT }, ...extra }),
        signal: AbortSignal.timeout(75000), redirect: 'error',
      });
    } catch { throw new AppError(502, 'The AI provider timed out or could not be reached. Please retry.', 'AI_UNREACHABLE'); }
    if (!response.ok) {
      // Do not log/return upstream bodies: they can contain prompts, credentials or PII.
      await response.body?.cancel();
      if (response.status === 429) throw new AppError(503, 'The AI provider is rate-limited or out of credit. Check your Meta Model API account and retry.', 'AI_RATE_LIMITED');
      if (response.status === 401 || response.status === 403) throw new AppError(503, 'Meta Model API rejected the configured credentials or model access. Check the Render settings.', 'AI_ACCESS_DENIED');
      throw new AppError(502, 'The AI provider rejected the request, possibly after a timeout. Check that the configured model supports Responses and the requested tools.', 'AI_PROVIDER_ERROR');
    }
    let data: z.infer<typeof ResponseSchema>;
    try { data = ResponseSchema.parse(await response.json()); }
    catch { throw new AppError(502, 'The AI provider returned an invalid response. Please retry.', 'AI_INVALID_RESPONSE'); }
    if (data.status !== 'completed') throw new AppError(502, 'The AI response was incomplete. Try a shorter request.', 'AI_INCOMPLETE');
    const content = data.output.flatMap(o => o.content ?? []);
    const text = content.filter(c => c.type === 'output_text').map(c => c.text ?? '').join('\n');
    if (!text) throw new AppError(502, 'The AI could not answer this request. Try rephrasing it.', 'AI_EMPTY_RESPONSE');
    return { data, text, content };
  }
  async structured<T extends z.ZodType>(model: string, instructions: string, input: unknown, schema: T): Promise<z.infer<T>> {
    const jsonSchema = z.toJSONSchema(schema, { target: 'draft-7' });
    delete jsonSchema.$schema;
    // Decoding is always constrained to the schema. strict:true additionally enforces a subset
    // (required must list every property) that our Zod schemas with optional fields violate.
    const { text } = await this.response(model, instructions, input, {
      text: { format: { type: 'json_schema', name: 'fairbuy_result', strict: false, schema: jsonSchema } },
    });
    try { return schema.parse(JSON.parse(text)); }
    catch { throw new AppError(502, 'The AI returned data that failed validation. Nothing was changed; please retry.', 'AI_INVALID_DATA'); }
  }
  async research(model: string, instructions: string, context: unknown): Promise<Research> {
    const { data, text, content } = await this.response(model, instructions, context, {
      tools: [{ type: 'web_search', search_context_size: 'medium' }],
      include: ['web_search_call.results'],
    });
    if (!data.output.some(o => o.type === 'web_search_call' && o.status === 'completed')) throw new AppError(502, 'No completed web search was returned. No unsourced products were accepted.', 'SEARCH_NOT_RUN');
    const sources = [
      ...data.output.flatMap(o => o.results ?? []),
      ...data.output.flatMap(o => o.action?.sources ?? []),
      ...content.flatMap(c => (c.annotations ?? []).filter(a => a.type === 'url_citation').map(a => ({ url: a.url ?? '', title: a.title }))),
    ].flatMap(s => { const url = safeUrl(s.url); return url ? [{ url, title: s.title ?? new URL(url).hostname }] : []; });
    return { text: text.slice(0, 40000), sources: [...new Map(sources.map(s => [s.url, s])).values()].slice(0, 80) };
  }
}
