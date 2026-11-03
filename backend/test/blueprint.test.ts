import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { settings } from '../src/settings';

const blueprint = parse(readFileSync(new URL('../../render.yaml', import.meta.url), 'utf8'));
const project = blueprint.projects[0];
const environment = project.environments[0];
const service = environment.services[0];

describe('Render Blueprint with externally managed Discovery model', () => {
  it('preserves the single Virginia free web service without a Render database', () => {
    expect(blueprint.projects).toHaveLength(1);
    expect(project.name).toBe('fairbuy');
    expect(project.environments).toHaveLength(1);
    expect(environment.name).toBe('production');
    expect(environment.services).toHaveLength(1);
    expect(service).toMatchObject({ name: 'fairbuy', region: 'virginia', plan: 'free', numInstances: 1, healthCheckPath: '/healthz', autoDeployTrigger: 'checksPass' });
    expect(service).not.toHaveProperty('preDeployCommand');
    expect(JSON.stringify(blueprint)).not.toMatch(/"(?:databases|fromDatabase)"/);
  });

  it('preserves secrets and the Discovery model across Blueprint syncs', () => {
    for (const key of ['DATABASE_URL', 'MODEL_API_KEY', 'APP_ACCESS_TOKEN', 'BACKOFFICE_ADMINS', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'BRAVE_API_KEY', 'DISCOVERY_MODEL']) {
      expect(service.envVars.filter((env: { key: string }) => env.key === key)).toEqual([{ key, sync: false }]);
    }
  });

  it('installs build tools explicitly and accepts synchronized application settings', () => {
    expect(service.buildCommand).toBe('npm ci --include=dev && npm run build && npm prune --omit=dev');
    expect(service.startCommand).toBe('node --env-file-if-exists=.env --env-file-if-exists=.env.backoffice backend/dist/main.js');
    const env = Object.fromEntries(service.envVars.filter((entry: { value?: string }) => entry.value !== undefined).map((entry: { key: string; value: string }) => [entry.key, entry.value]));
    expect(() => settings({ ...env, DATABASE_URL: 'postgresql://test:test@localhost:5432/fairbuy_test', DISCOVERY_MODEL: 'muse-spark-1.3-contributor' })).not.toThrow();
  });
});
