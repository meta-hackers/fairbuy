import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const blueprint = parse(readFileSync(new URL('../../render.yaml', import.meta.url), 'utf8'));

const project = blueprint.projects[0];
const environment = project.environments[0];
const service = environment.services[0];

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

  it('leaves provider credentials and the app password out of source control', () => {
    for (const key of ['MODEL_API_KEY', 'APP_ACCESS_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']) {
      expect(service.envVars.filter((env: { key: string }) => env.key === key))
        .toEqual([{ key, sync: false }]);
    }
  });

  it('uses a separate non-reasoning Meta model for the optional instant classifier', () => {
    expect(service.envVars).toContainEqual({ key: 'INSTANT_CLASSIFIER_PROVIDER', value: 'cloudflare' });
    expect(service.envVars).toContainEqual({ key: 'INSTANT_CLASSIFIER_MODEL', value: '@cf/meta/llama-3.1-8b-instruct-fp8-fast' });
  });

  it('configures independent reasoning effort defaults for each stage', () => {
    expect(service.envVars.filter((env: { key: string }) => env.key.endsWith('REASONING_EFFORT'))).toEqual([
      { key: 'ASK_REASONING_EFFORT', value: 'low' },
      { key: 'CONFIGURE_REASONING_EFFORT', value: 'low' },
      { key: 'DISCOVERY_REASONING_EFFORT', value: 'medium' },
    ]);
  });

  it('bundles the public Supabase trust root for verified TLS connections', () => {
    const certificate = new X509Certificate(readFileSync(new URL('../../certs/supabase-ca.crt', import.meta.url)));
    expect(certificate.ca).toBe(true);
    expect(certificate.fingerprint256).toBe('80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA');
  });
});
