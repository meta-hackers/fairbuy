import { currencyForCountry, ShoppingLocationSchema, type ShoppingLocation } from '@fairbuy/core';
import { AppError } from './errors';

export class LocationResolver {
  private cache = new Map<string, { at: number; location: ShoppingLocation }>();
  private pending = new Map<string, Promise<ShoppingLocation>>();
  private nextRequestAt = 0;
  constructor(private request: typeof fetch = fetch) {}

  async reverse(latitude: number, longitude: number): Promise<ShoppingLocation> {
    // City-level lookup only: never send or store the browser's precise coordinates.
    const lat = latitude.toFixed(2), lon = longitude.toFixed(2), key = `${lat},${lon}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < 86400000) return cached.location;
    const pending = this.pending.get(key);
    if (pending) return pending;
    // Respect the public Nominatim service's one-request-per-second limit.
    if (Date.now() < this.nextRequestAt) throw new AppError(503, 'Location lookup is busy. Try again shortly or set your location manually.');
    this.nextRequestAt = Date.now() + 1100;
    const lookup = this.lookup(lat, lon);
    this.pending.set(key, lookup);
    try {
      const location = await lookup;
      if (this.cache.size >= 500) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { at: Date.now(), location });
      return location;
    } finally { this.pending.delete(key); }
  }

  private async lookup(latitude: string, longitude: string): Promise<ShoppingLocation> {
    try {
      const url = new URL('https://nominatim.openstreetmap.org/reverse');
      url.search = new URLSearchParams({ lat: latitude, lon: longitude, format: 'jsonv2', zoom: '10', addressdetails: '1', 'accept-language': 'en' }).toString();
      const response = await this.request(url, {
        headers: { 'User-Agent': 'FairBuy/1.0 (https://github.com/meta-hackers/fairbuy)', Accept: 'application/json' },
        signal: AbortSignal.timeout(5000), redirect: 'error',
      });
      if (!response.ok) throw new Error('Lookup unavailable');
      const data = await response.json() as { address?: Record<string, unknown> };
      const address = data.address;
      const country = typeof address?.country_code === 'string' ? address.country_code.toUpperCase() : '';
      const city = [address?.city, address?.town, address?.village, address?.municipality, address?.state].find(value => typeof value === 'string' && value.trim());
      return ShoppingLocationSchema.parse({ country, city: typeof city === 'string' ? city.slice(0, 120) : null, currency: currencyForCountry(country) });
    } catch {
      throw new AppError(503, 'Could not determine your city and country. You can set your shopping location manually.');
    }
  }
}
