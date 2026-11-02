import { describe, expect, it } from 'vitest';
import { CoordinatesSchema, currencyForCountry, ShoppingLocationSchema } from './location';

describe('shopping location', () => {
  it.each([
    ['CH', 'CHF'], ['LI', 'CHF'], ['IT', 'EUR'], ['FR', 'EUR'], ['BG', 'EUR'], ['US', 'USD'], ['GB', 'GBP'], ['ch', 'CHF'],
    ['CA', 'CAD'], ['JP', 'JPY'], ['IN', 'INR'], ['AU', 'AUD'], ['BR', 'BRL'], ['ZA', 'ZAR'], ['AE', 'AED'], ['CN', 'CNY'],
  ])('suggests %s → %s', (country, currency) => {
    expect(currencyForCountry(country)).toBe(currency);
  });
  it.each(['ZZ', ''])('returns no currency for unknown country code %s', country => {
    expect(currencyForCountry(country)).toBeNull();
  });
  it('validates coordinates and rejects extra fields or arbitrary URLs', () => {
    expect(CoordinatesSchema.safeParse({ latitude: 47.38, longitude: 8.54 }).success).toBe(true);
    for (const input of [{ latitude: 91, longitude: 0 }, { latitude: 0, longitude: -181 }, { latitude: '47', longitude: 8 }, { latitude: 0, longitude: 0, url: 'http://localhost' }]) {
      expect(CoordinatesSchema.safeParse(input).success).toBe(false);
    }
    expect(ShoppingLocationSchema.safeParse({ country: 'CH', city: 'Zurich', currency: 'CHF' }).success).toBe(true);
    expect(ShoppingLocationSchema.safeParse({ country: 'ch', city: null, currency: 'CHF' }).success).toBe(false);
  });
});
