import { describe, expect, it } from 'vitest';
import { settings } from '../src/settings';
import { verifyPassword } from '../src/admin';

const effortKeys = ['ASK_REASONING_EFFORT', 'CONFIGURE_REASONING_EFFORT', 'DISCOVERY_REASONING_EFFORT'] as const;
const modelKeyForEffort = {
  ASK_REASONING_EFFORT: 'ASK_MODEL',
  CONFIGURE_REASONING_EFFORT: 'CONFIGURE_MODEL',
  DISCOVERY_REASONING_EFFORT: 'DISCOVERY_MODEL',
} as const;

describe('HTTP port binding configuration', () => {
  it('uses the documented fallback when PORT is unset or empty', () => {
    expect(settings({}).PORT).toBe(4000);
    expect(settings({ PORT: '' }).PORT).toBe(4000);
  });
  it('honors Render PORT and explicit local overrides as numeric ports', () => {
    expect(settings({ PORT: '10000' }).PORT).toBe(10000);
    expect(settings({ PORT: '3001' }).PORT).toBe(3001);
  });
  it.each(['0', '-1', '65536', '4000.5', 'invalid'])('rejects invalid PORT %s', PORT => {
    expect(() => settings({ PORT })).toThrow();
  });
});

describe('administrator password configuration', () => {
  it('accepts multiple plaintext passwords, hashes them internally, and remains stable across restarts', async () => {
    const env = { BACKOFFICE_ADMINS: JSON.stringify([{ username: 'FirstAdmin', password: 'first-test-password' }, { username: 'SecondAdmin', password: 'second-test-password' }]) };
    const config = settings(env);
    expect(config.BACKOFFICE_ADMINS).toEqual(settings(env).BACKOFFICE_ADMINS);
    expect(JSON.stringify(config.BACKOFFICE_ADMINS)).not.toContain('first-test-password');
    expect(await verifyPassword('first-test-password', config.BACKOFFICE_ADMINS[0].passwordHash)).toBe(true);
    expect(await verifyPassword('second-test-password', config.BACKOFFICE_ADMINS[1].passwordHash)).toBe(true);
    expect(await verifyPassword('wrong', config.BACKOFFICE_ADMINS[0].passwordHash)).toBe(false);
  });
  it('rejects ambiguous credentials, empty passwords, and duplicate usernames', () => {
    const parse = (admins: unknown) => settings({ BACKOFFICE_ADMINS: JSON.stringify(admins) });
    expect(() => parse([{ username: 'Admin', password: '' }])).toThrow();
    expect(() => parse([{ username: 'Admin', password: 'test', passwordHash: `scrypt:${'a'.repeat(32)}:${'b'.repeat(128)}` }])).toThrow();
    expect(() => parse([{ username: 'Admin', password: 'test' }, { username: 'ADMIN', password: 'other' }])).toThrow();
    expect(() => parse([{ username: 'Admin' }])).toThrow();
  });
});

describe('optional instant classifier settings', () => {
  it('does not require Cloudflare to start or change the main AI models', () => {
    const config = settings({});
    expect(config.INSTANT_CLASSIFIER_PROVIDER).toBe('disabled');
    expect(config.INSTANT_CLASSIFIER_MODEL).toBe('@cf/meta/llama-3.1-8b-instruct-fp8-fast');
    expect(config.CLOUDFLARE_API_TOKEN).toBe('');
    expect(config.ASK_MODEL).toBe('muse-spark-1.3-contributor');
  });
  it('only accepts the intended non-reasoning Meta models and a valid account ID', () => {
    expect(() => settings({ INSTANT_CLASSIFIER_MODEL: 'muse-spark-1.3' })).toThrow();
    expect(() => settings({ INSTANT_CLASSIFIER_MODEL: '@cf/meta/llama-3.2-1b-instruct' })).toThrow();
    for (const model of ['@cf/meta/llama-3.2-3b-instruct', '@cf/meta/llama-3.1-8b-instruct-fp8-fast', '@cf/meta/llama-3.1-8b-instruct-fp8']) {
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

  it.each(effortKeys)('allows max reasoning on standard models for %s', key => {
    for (const model of ['muse-spark-1.3', 'muse-wonder-1.0']) {
      expect(settings({ [modelKeyForEffort[key]]: model, [key]: 'max' })[key]).toBe('max');
    }
  });

  it.each(effortKeys)('rejects none and max reasoning with the contributor model for %s', key => {
    for (const effort of ['none', 'max']) {
      expect(() => settings({ [modelKeyForEffort[key]]: 'muse-spark-1.3-contributor', [key]: effort })).toThrow();
    }
  });

  it.each(effortKeys)('rejects unsupported values for %s', key => {
    for (const effort of ['', 'none', 'LOW', 'invalid']) {
      expect(() => settings({ [key]: effort })).toThrow();
    }
  });
});
