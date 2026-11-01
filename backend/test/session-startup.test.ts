import { describe, expect, it, vi } from 'vitest';
import { settings } from '../src/settings';
import { sessionStartup } from '../src/session-startup';
import { ShoppingService } from '../src/shopping-service';
import { MemoryStore } from '../src/store';
import { DemoAIProvider } from '../src/ai/demo';

describe('session startup configuration', () => {
  it('captures independent models and efforts, including Learn and extraction, without secrets', () => {
    const config = settings({
      ASK_MODEL: 'ask-model', CONFIGURE_MODEL: 'configure-model', DISCOVERY_MODEL: 'discovery-model',
      ASK_REASONING_EFFORT: 'minimal', CONFIGURE_REASONING_EFFORT: 'medium', DISCOVERY_REASONING_EFFORT: 'high',
      SEARCH_PROVIDER: 'brave', INSTANT_CLASSIFIER_PROVIDER: 'cloudflare',
      MODEL_API_KEY: 'secret-model', BRAVE_API_KEY: 'secret-brave', CLOUDFLARE_API_TOKEN: 'secret-cloudflare',
      DATABASE_URL: 'secret-database', APP_ACCESS_TOKEN: 'secret-access',
    });
    const snapshot = sessionStartup(config);
    expect(snapshot).toMatchObject({
      schemaVersion: 1, mode: 'live', aiEnabled: true,
      ask: { model: 'ask-model', effort: 'minimal' },
      configure: { model: 'configure-model', effort: 'medium' },
      learn: { model: 'configure-model', effort: 'medium' },
      discovery: { model: 'discovery-model', effort: 'high', searchProvider: 'brave' },
      extraction: { model: 'discovery-model', effort: 'low', maxOutputTokens: 16000 },
      instantClassifier: { provider: 'cloudflare', model: config.INSTANT_CLASSIFIER_MODEL },
    });
    expect(JSON.stringify(snapshot)).not.toContain('secret-');
  });

  it('passes a startup snapshot to storage for every new session', async () => {
    const store = new MemoryStore();
    const create = vi.spyOn(store, 'create');
    const config = settings({ ASK_MODEL: 'original-model' });
    const service = new ShoppingService(store, new DemoAIProvider(), 'demo', undefined, config);
    config.ASK_MODEL = 'changed-model';
    for (let i = 0; i < 2; i++) {
      const session = await service.create('owner');
      expect(create).toHaveBeenLastCalledWith('owner', session, expect.objectContaining({
        mode: 'demo', aiEnabled: false, ask: { model: 'original-model', effort: 'low' },
      }));
    }
  });
});
