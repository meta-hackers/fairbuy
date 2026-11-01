import { describe, expect, it } from 'vitest';
import { settings } from '../src/settings';

const effortKeys = ['ASK_REASONING_EFFORT', 'CONFIGURE_REASONING_EFFORT', 'DISCOVERY_REASONING_EFFORT'] as const;

describe('optional instant classifier settings', () => {
  it('does not require Cloudflare to start or change the main AI models', () => {
    const config = settings({});
    expect(config.INSTANT_CLASSIFIER_PROVIDER).toBe('disabled');
    expect(config.INSTANT_CLASSIFIER_MODEL).toBe('@cf/meta/llama-3.2-1b-instruct');
    expect(config.CLOUDFLARE_API_TOKEN).toBe('');
    expect(config.ASK_MODEL).toBe('muse-spark-1.3-contributor');
  });
  it('only accepts the intended non-reasoning Meta models and a valid account ID', () => {
    expect(() => settings({ INSTANT_CLASSIFIER_MODEL: 'muse-spark-1.3' })).toThrow();
    for (const model of ['@cf/meta/llama-3.2-3b-instruct', '@cf/meta/llama-3.1-8b-instruct-fp8-fast']) {
      expect(settings({ INSTANT_CLASSIFIER_MODEL: model }).INSTANT_CLASSIFIER_MODEL).toBe(model);
    }
    expect(() => settings({ CLOUDFLARE_ACCOUNT_ID: 'invalid/account' })).toThrow();
    expect(settings({ INSTANT_CLASSIFIER_PROVIDER: 'cloudflare', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32) }).INSTANT_CLASSIFIER_PROVIDER).toBe('cloudflare');
  });
});

describe('per-stage reasoning effort settings', () => {
  it('defaults to low for Ask and Configure, and xhigh for Discovery', () => {
    expect(settings({})).toMatchObject({
      ASK_REASONING_EFFORT: 'low', CONFIGURE_REASONING_EFFORT: 'low', DISCOVERY_REASONING_EFFORT: 'xhigh',
    });
  });

  it.each(effortKeys)('allows %s to be configured independently', key => {
    const defaults = settings({});
    for (const effort of ['minimal', 'low', 'medium', 'high', 'xhigh']) {
      expect(settings({ [key]: effort })).toEqual({ ...defaults, [key]: effort });
    }
  });

  it.each(effortKeys)('rejects unsupported values for %s', key => {
    for (const effort of ['', 'max', 'LOW', 'invalid']) {
      expect(() => settings({ [key]: effort })).toThrow();
    }
  });
});
