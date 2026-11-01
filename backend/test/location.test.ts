import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocationResolver } from '../src/location';
import { createApp } from '../src/app';
import { MemoryStore } from '../src/store';
import { ShoppingService } from '../src/shopping-service';
import { DemoAIProvider } from '../src/ai/demo';
import { settings } from '../src/settings';

afterEach(() => vi.restoreAllMocks());
const headers = { 'X-Fairbuy-Request': '1' };
function setup() {
  const config = settings({ NODE_ENV: 'test', FAIRBUY_MODE: 'demo' });
  const resolver = new LocationResolver();
  const app = createApp(new ShoppingService(new MemoryStore(), new DemoAIProvider(), 'demo'), config, resolver);
  return { app, resolver };
}

describe('city-level reverse geocoding', () => {
  it('uses a fixed endpoint, rounded coordinates, timeout and a bounded city-only result', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ address: { country_code: 'ch', city: 'Zurich', road: 'Private street', house_number: '42' } })));
    const resolver = new LocationResolver(fetcher);
    const result = await resolver.reverse(47.3769, 8.5417);
    expect(result).toEqual({ country: 'CH', city: 'Zurich', currency: 'CHF' });
    const [url, options] = fetcher.mock.calls[0];
    expect(String(url)).toContain('https://nominatim.openstreetmap.org/reverse?lat=47.38&lon=8.54');
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.headers).toMatchObject({ 'User-Agent': expect.stringContaining('FairBuy') });
    expect(await resolver.reverse(47.3768, 8.5416)).toEqual(result);
    expect(fetcher).toHaveBeenCalledOnce();
    await expect(resolver.reverse(0, 0)).rejects.toThrow('busy');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('supports town results without inventing a currency', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ address: { country_code: 'ca', town: 'Banff' } })));
    expect(await new LocationResolver(fetcher).reverse(51.18, -115.57)).toEqual({ country: 'CA', city: 'Banff', currency: null });
  });
  it.each([new Response('{}'), new Response('unavailable', { status: 503 })])('handles missing countries and upstream errors safely', async response => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    await expect(new LocationResolver(fetcher).reverse(0, 0)).rejects.toThrow('set your shopping location manually');
  });
  it('hides network failures', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('Internal provider details'));
    await expect(new LocationResolver(fetcher).reverse(0, 0)).rejects.toThrow('Could not determine your city and country');
  });
});

describe('location HTTP API', () => {
  it('validates lookup input and never fetches arbitrary URLs', async () => {
    const { app, resolver } = setup(); const lookup = vi.spyOn(resolver, 'reverse').mockResolvedValue({ country: 'CH', city: 'Zurich', currency: 'CHF' });
    await request(app).post('/api/location/reverse').send({ latitude: 47, longitude: 8 }).expect(403);
    await request(app).post('/api/location/reverse').set(headers).send({ latitude: 91, longitude: 8 }).expect(400);
    await request(app).post('/api/location/reverse').set(headers).send({ latitude: 47, longitude: 8, url: 'http://localhost' }).expect(400);
    expect(lookup).not.toHaveBeenCalled();
    const result = await request(app).post('/api/location/reverse').set(headers).send({ latitude: 47.38, longitude: 8.54 }).expect(200);
    expect(result.body).toEqual({ country: 'CH', city: 'Zurich', currency: 'CHF' });
    expect(result.headers['cache-control']).toBe('no-store');
  });
  it('seeds the first conversation without marking an empty brief ready', async () => {
    const { app } = setup(); const client = request.agent(app);
    const created = await client.post('/api/sessions').set(headers).send({ location: { country: 'CH', city: 'Zurich', currency: 'CHF' } }).expect(201);
    expect(created.body.config).toMatchObject({ country: 'CH', city: 'Zurich', currency: 'CHF' });
    expect(created.body.ready).toBe(false);
    const answer = await client.post(`/api/sessions/${created.body.id}/ask`).set(headers).send({ message: 'A laptop for coding' }).expect(200);
    expect(answer.body.ready).toBe(true);
    expect(answer.body.config).toMatchObject({ country: 'CH', city: 'Zurich', currency: 'CHF' });
    expect((await client.get('/api/bootstrap')).body.session.config.currency).toBe('CHF');
  });
  it('accepts late or manual locations in Ask, respects ownership and preserves an existing country', async () => {
    const { app } = setup(); const client = request.agent(app); const other = request.agent(app);
    const { body: session } = await client.post('/api/sessions').set(headers).expect(201);
    const path = `/api/sessions/${session.id}/location`;
    await other.patch(path).set(headers).send({ country: 'CH', city: 'Zurich', currency: 'CHF' }).expect(404);
    await client.patch(path).set(headers).send({ country: 'CH', city: 'Zurich', currency: 'CHF', onlyIfMissing: true }).expect(200);
    const kept = await client.patch(path).set(headers).send({ country: 'IT', city: 'Milan', currency: 'EUR', onlyIfMissing: true }).expect(200);
    expect(kept.body.config.country).toBe('CH');
    const manual = await client.patch(path).set(headers).send({ country: 'GB', city: 'London', currency: 'GBP' }).expect(200);
    expect(manual.body.config).toMatchObject({ country: 'GB', city: 'London', currency: 'GBP' });
    await client.patch(path).set(headers).send({ country: 'UK', city: null, currency: 'INVALID' }).expect(400);
  });
  it('does not change location while discovery is active', async () => {
    const { app } = setup(); const client = request.agent(app);
    const { body: session } = await client.post('/api/sessions').set(headers).send({ location: { country: 'CH', city: 'Zurich', currency: 'CHF' } });
    await client.post(`/api/sessions/${session.id}/ask`).set(headers).send({ message: 'A laptop for coding' }).expect(200);
    await client.post(`/api/sessions/${session.id}/discovery`).set(headers).expect(202);
    await client.patch(`/api/sessions/${session.id}/location`).set(headers).send({ country: 'IT', city: 'Milan', currency: 'EUR' }).expect(409);
    expect((await client.get(`/api/sessions/${session.id}`)).body.config.country).toBe('CH');
  });
});
