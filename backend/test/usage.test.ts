import { describe, expect, it, vi } from 'vitest';
import { UsageStore, recordUsage } from '../src/usage';
import { MetaClient } from '../src/ai/meta';
import { settings } from '../src/settings';
import { summarizeUsage } from '../src/admin';

describe('usage accounting', () => {
  it('preserves unknowns and records zero tokens as known without double-counting subsets', async () => {
    const store = new UsageStore();
    await store.capture('s', 'ask', null, async () => {
      recordUsage('meta', 'm', 'generation', 'completed', 5, { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 80 }, output_tokens_details: { reasoning_tokens: 10 } }, { m: { input: 2, output: 4 } });
      recordUsage('meta', 'm', 'generation', 'completed', 5, { input_tokens: 0, output_tokens: 0 }, { '*': { input: 1, output: 3 } });
      recordUsage('meta', 'm', 'generation', 'failed', 5);
    });
    const events = await store.get('s');
    expect(events[0]).toMatchObject({ inputTokens: 100, outputTokens: 20, cachedTokens: 80, reasoningTokens: 10, phase: 'ask' });
    expect(events[0].estimatedCostUsd).toBeCloseTo(0.00028);
    expect(events[1]).toMatchObject({ inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 });
    expect(events[2]).toMatchObject({ inputTokens: null, outputTokens: null, estimatedCostUsd: null });
    expect(summarizeUsage(events)).toMatchObject({ inputTokens: 100, outputTokens: 20, partial: true });
    expect(summarizeUsage([])).toMatchObject({ calls: 0, inputTokens: null, estimatedCostUsd: null });
  });
  it('isolates concurrent sessions and preserves paid calls on failure', async () => {
    const store = new UsageStore();
    await Promise.all(['a', 'b'].map(id => store.capture(id, id === 'a' ? 'discovery' : 'learn', id === 'a' ? 'round' : null, async () => {
      await Promise.resolve(); recordUsage('meta', 'm', 'generation', 'completed', 5, { input_tokens: 12, output_tokens: 6 });
    })));
    await expect(store.capture('a', 'ask', null, async () => { recordUsage('meta', 'm', 'generation', 'failed', 2); throw new Error('rollback'); })).rejects.toThrow('rollback');
    expect(await store.get('a')).toHaveLength(2);
    expect((await store.get('a'))[0]).toMatchObject({ phase: 'discovery', roundId: 'round' });
    expect(await store.get('b')).toHaveLength(1);
    expect((await store.get('b'))[0]).toMatchObject({ phase: 'learn', roundId: null });
  });
  it('reads terminal provider usage, including incomplete responses, and does not duplicate calls', async () => {
    const store = new UsageStore();
    const config = settings({ MODEL_API_KEY: 'test-only', SEARCH_PROVIDER: 'meta' });
    const payload = { status: 'completed', usage: { input_tokens: 40, output_tokens: 10 }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] };
    const response = (data: unknown, type = 'response.completed') => new Response(`data: ${JSON.stringify({ type, response: data })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(payload)).mockResolvedValueOnce(response({ ...payload, status: 'incomplete' }, 'response.incomplete')).mockRejectedValueOnce(new Error('timeout'));
    const client = new MetaClient(config, fetcher);
    await store.capture('s', 'discovery', 'r', async () => {
      await client.response('m', 'private instructions', { draft: 'private draft' });
      await expect(client.response('m', 'private instructions', {})).rejects.toMatchObject({ code: 'AI_INCOMPLETE' });
      await expect(client.response('m', 'private instructions', {})).rejects.toMatchObject({ code: 'AI_UNREACHABLE' });
    });
    const events = await store.get('s');
    expect(events).toHaveLength(3);
    expect(events.map(e => e.status)).toEqual(['completed', 'incomplete', 'failed']);
    expect(events.map(e => e.inputTokens)).toEqual([40, 40, null]);
    expect(JSON.stringify(events)).not.toContain('private');
  });
});
