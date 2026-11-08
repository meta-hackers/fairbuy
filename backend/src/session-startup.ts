import type { Settings } from './settings';

// Explicit allowlist: never persist environment variables or credentials wholesale.
export function sessionStartup(config: Settings, mode: 'live' | 'demo' = config.FAIRBUY_MODE) {
  return {
    schemaVersion: 1,
    mode,
    aiEnabled: mode === 'live',
    ask: { model: config.ASK_MODEL, effort: config.ASK_REASONING_EFFORT },
    configure: { model: config.CONFIGURE_MODEL, effort: config.CONFIGURE_REASONING_EFFORT },
    learn: { model: config.CONFIGURE_MODEL, effort: config.CONFIGURE_REASONING_EFFORT },
    discovery: { model: config.DISCOVERY_MODEL, effort: config.DISCOVERY_REASONING_EFFORT, searchProvider: config.SEARCH_PROVIDER },
    sellerSearch: {
      model: config.SELLER_SEARCH_MODEL, effort: config.SELLER_SEARCH_REASONING_EFFORT,
      extractionEffort: 'low', maxOutputTokens: 8000, searchProvider: config.SEARCH_PROVIDER,
    },
    extraction: { model: config.DISCOVERY_MODEL, effort: 'low', maxOutputTokens: 16000 },
    instantClassifier: { provider: config.INSTANT_CLASSIFIER_PROVIDER, model: config.INSTANT_CLASSIFIER_MODEL },
    illustrationClassifier: { provider: config.ILLUSTRATION_CLASSIFIER_PROVIDER, model: config.ILLUSTRATION_CLASSIFIER_MODEL },
  };
}

export type SessionStartup = ReturnType<typeof sessionStartup>;
