import { z } from 'zod';
import { CurrencySchema } from './contract';

export const CoordinatesSchema = z.object({
  latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180),
}).strict();
export const ShoppingLocationSchema = z.object({
  country: z.string().regex(/^[A-Z]{2}$/), city: z.string().trim().max(120).nullable(),
  currency: CurrencySchema.nullable(),
}).strict();
export type ShoppingLocation = z.infer<typeof ShoppingLocationSchema>;

// Only suggest currencies that FairBuy supports. Never infer a country from language,
// or silently label a non-euro country as EUR.
const euroCountries = new Set('AD AT AX BE BG BL CY DE EE ES FI FR GF GP GR HR IE IT LT LU LV MC ME MF MQ MT NL PM PT RE SI SK SM TF VA XK YT'.split(' '));
const dollarCountries = new Set('AS BQ EC FM GU IO MH MP PA PR PW SV TC TL UM US VG VI'.split(' '));
export function currencyForCountry(country: string): z.infer<typeof CurrencySchema> | null {
  const code = country.toUpperCase();
  if (euroCountries.has(code)) return 'EUR';
  if (code === 'CH' || code === 'LI') return 'CHF';
  if (['GB', 'GG', 'IM', 'JE'].includes(code)) return 'GBP';
  if (dollarCountries.has(code)) return 'USD';
  return null;
}
