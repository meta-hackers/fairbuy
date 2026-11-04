import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { settings } from '../src/settings';

describe('deployment prerequisites', () => {
  it('defaults Discovery and Buy seller search to independent Muse Spark configurations', () => {
    expect(settings({})).toMatchObject({
      DISCOVERY_MODEL: 'muse-spark-1.3-contributor', SELLER_SEARCH_MODEL: 'muse-spark-1.3-contributor',
    });
    expect(settings({ DISCOVERY_MODEL: 'muse-spark-1.3-contributor', DISCOVERY_REASONING_EFFORT: 'medium' }))
      .toMatchObject({ DISCOVERY_MODEL: 'muse-spark-1.3-contributor', DISCOVERY_REASONING_EFFORT: 'medium' });
    expect(settings({ SELLER_SEARCH_MODEL: 'seller-model', SELLER_SEARCH_REASONING_EFFORT: 'high' }))
      .toMatchObject({ SELLER_SEARCH_MODEL: 'seller-model', SELLER_SEARCH_REASONING_EFFORT: 'high' });
  });

  it('bundles the public Supabase trust root for verified TLS connections', () => {
    const certificate = new X509Certificate(readFileSync(new URL('../../certs/supabase-ca.crt', import.meta.url)));
    expect(certificate.ca).toBe(true);
    expect(certificate.fingerprint256).toBe('80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA');
  });
});
