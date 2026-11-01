import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const blueprint = parse(readFileSync(new URL('../../render.yaml', import.meta.url), 'utf8'));

describe('existing Render resource adoption', () => {
  it('preserves the live database identity, free plan and restricted external access', () => {
    expect(blueprint.databases).toEqual([{
      name: 'sample-postgres',
      region: 'frankfurt',
      plan: 'free',
      postgresMajorVersion: '18',
      databaseName: 'sample_postgres_baoy',
      user: 'sample_postgres_baoy_user',
      ipAllowList: [
        { source: '74.220.49.0/24', description: 'fairbuy-us virginia outbound' },
        { source: '74.220.57.0/24', description: 'fairbuy-us virginia outbound' },
      ],
    }]);
  });

  it('keeps the Virginia web service and its existing external database secret', () => {
    expect(blueprint.services).toHaveLength(1);
    const service = blueprint.services[0];
    expect(service).toMatchObject({ name: 'fairbuy', region: 'virginia', plan: 'free', startCommand: 'npm start' });
    expect(service).not.toHaveProperty('preDeployCommand');
    // An internal fromDatabase URL cannot reach Frankfurt from Virginia and
    // would select the wrong logical database instead of the existing fairbuy DB.
    expect(service.envVars.filter((env: { key: string }) => env.key === 'DATABASE_URL'))
      .toEqual([{ key: 'DATABASE_URL', sync: false }]);
  });

  it('leaves provider credentials and the app password out of source control', () => {
    for (const key of ['MODEL_API_KEY', 'APP_ACCESS_TOKEN']) {
      expect(blueprint.services[0].envVars.filter((env: { key: string }) => env.key === key))
        .toEqual([{ key, sync: false }]);
    }
  });
});
