import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { settings } from '../src/settings';

const blueprint = parse(readFileSync(new URL('../../render.yaml', import.meta.url), 'utf8'));

const project = blueprint.projects[0];
const environment = project.environments[0];
const service = environment.services[0];

const stageConfigs = [
  ['ASK_MODEL', 'ASK_REASONING_EFFORT'],
  ['CONFIGURE_MODEL', 'CONFIGURE_REASONING_EFFORT'],
  ['DISCOVERY_MODEL', 'DISCOVERY_REASONING_EFFORT'],
] as const;
const supportedStageModels = ['muse-spark-1.3', 'muse-spark-1.3-contributor', 'muse-wonder-1.0'];

describe('Render web deployment with Supabase PostgreSQL', () => {
  it('groups the web service in the fairbuy production project without a Render database', () => {
    expect(blueprint.projects).toHaveLength(1);
    expect(project.name).toBe('fairbuy');
    expect(project.environments).toHaveLength(1);
    expect(environment.name).toBe('production');
    expect(environment.services).toHaveLength(1);
    expect(blueprint.services).toBeUndefined();
    expect(JSON.stringify(blueprint)).not.toContain('"databases"');
    expect(JSON.stringify(blueprint)).not.toContain('"fromDatabase"');
  });

  it('keeps the Virginia free web plan and external database connection secret', () => {
    expect(service).toMatchObject({ name: 'fairbuy', region: 'virginia', plan: 'free', startCommand: 'node --env-file-if-exists=.env --env-file-if-exists=.env.backoffice backend/dist/main.js' });
    expect(service.healthCheckPath).toBe('/healthz');
    expect(service).not.toHaveProperty('preDeployCommand');
    expect(service.envVars.filter((env: { key: string }) => env.key === 'DATABASE_URL'))
      .toEqual([{ key: 'DATABASE_URL', sync: false }]);
  });

  it('installs build-only dev dependencies despite NODE_ENV=production', () => {
    // Render passes service env vars to the build, and `npm ci` omits
    // devDependencies when NODE_ENV=production. TypeScript, Vite and the React
    // type packages are build-only, so the install must opt back in.
    expect(service.envVars).toContainEqual({ key: 'NODE_ENV', value: 'production' });
    expect(service.buildCommand).toContain('npm ci --include=dev');
    expect(service.buildCommand).toContain('npm prune --omit=dev');
  });

  it('leaves provider credentials and the app password out of source control', () => {
    for (const key of ['MODEL_API_KEY', 'APP_ACCESS_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']) {
      expect(service.envVars.filter((env: { key: string }) => env.key === key))
        .toEqual([{ key, sync: false }]);
    }
  });

  it('uses a separate non-reasoning Meta model for the optional instant classifier', () => {
    expect(service.envVars).toContainEqual({ key: 'INSTANT_CLASSIFIER_PROVIDER', value: 'cloudflare' });
    const model = service.envVars.find((env: { key: string }) => env.key === 'INSTANT_CLASSIFIER_MODEL')?.value;
    expect(() => settings({ INSTANT_CLASSIFIER_MODEL: model })).not.toThrow();
  });

  it('uses a supported Meta reasoning model for every stage', () => {
    const stageModelKeys: string[] = stageConfigs.map(([modelKey]) => modelKey);
    const models = service.envVars.filter((env: { key: string }) => stageModelKeys.includes(env.key));
    expect(models.map((env: { key: string }) => env.key).sort()).toEqual([...stageModelKeys].sort());
    for (const env of models as { key: string; value: string }[]) {
      expect(supportedStageModels).toContain(env.value);
    }
  });

  it('accepts the configured model and reasoning effort for every stage', () => {
    const envVars = Object.fromEntries(
      service.envVars.map((env: { key: string; value: string }) => [env.key, env.value]),
    ) as Record<string, string>;
    for (const [modelKey, effortKey] of stageConfigs) {
      expect(envVars).toHaveProperty(modelKey);
      expect(envVars).toHaveProperty(effortKey);
      expect(() => settings({ [modelKey]: envVars[modelKey], [effortKey]: envVars[effortKey] })).not.toThrow();
    }
  });

  it('bundles the public Supabase trust root for verified TLS connections', () => {
    const certificate = new X509Certificate(readFileSync(new URL('../../certs/supabase-ca.crt', import.meta.url)));
    expect(certificate.ca).toBe(true);
    expect(certificate.fingerprint256).toBe('80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA');
  });
});
