import { describe, expect, it } from 'vitest';
import { settings } from '../src/settings';

const effortKeys = ['ASK_REASONING_EFFORT', 'CONFIGURE_REASONING_EFFORT', 'DISCOVERY_REASONING_EFFORT'] as const;

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
