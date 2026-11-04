// Confirms an extracted offer against its seller page (issue #40). Extraction quotes
// are checked against the research model's notes, so a price or stock claim the
// model wrote there is not evidence that the page says it.
import { CurrencySchema, type Currency, type Offer } from '@fairbuy/core';
import { decodeHtmlEntities, readPage, type Page } from './product-images';
import { recordDiagnostic } from './diagnostics';

export const UNCONFIRMED_PRICE = 'Price could not be confirmed on the seller page';
const PAGE_CHECK_TIMEOUT_MS = 8000;

export interface PagePrice { amount: number; currency: Currency }
export interface PageEvidence { prices: PagePrice[]; availability: Offer['availability'] | null; text: string }
export type PageReader = (url: string, signal?: AbortSignal) => Promise<Page | null>;

/** Reads "69857", "69857.00", "69.857" or "1.299,90" as major units. */
export function parsePageAmount(value: string): number | null {
  const raw = value.replace(/[^\d.,]/g, '');
  if (!/\d/.test(raw)) return null;
  const last = Math.max(raw.lastIndexOf('.'), raw.lastIndexOf(','));
  if (last < 0) return Number(raw);
  const tail = raw.slice(last + 1);
  // Prices do not have three decimals: "69.857" groups thousands, "1.299,90" has cents.
  if (tail.length > 0 && tail.length <= 2) return Number(`${raw.slice(0, last).replace(/[.,]/g, '')}.${tail}`);
  return Number(raw.replace(/[.,]/g, ''));
}

function availabilityOf(value: unknown): Offer['availability'] | null {
  const text = String(value ?? '').toLowerCase();
  if (/outofstock|soldout|discontinued/.test(text)) return 'sold_out';
  if (/instock|limitedavailability|onlineonly|instoreonly/.test(text)) return 'available';
  return null;
}
function currencyOf(value: unknown): Currency | null {
  const parsed = CurrencySchema.safeParse(String(value ?? '').trim().toUpperCase());
  return parsed.success ? parsed.data : null;
}

/** Structured price and stock from JSON-LD, meta tags and microdata, plus the visible text. */
export function pagePriceEvidence(html: string): PageEvidence {
  const prices: PagePrice[] = [];
  let availability: Offer['availability'] | null = null;
  const add = (amountValue: unknown, currencyValue: unknown) => {
    const currency = currencyOf(currencyValue);
    const amount = amountValue === undefined || amountValue === null ? null
      : typeof amountValue === 'number' ? amountValue : parsePageAmount(String(amountValue));
    if (currency && amount !== null && Number.isFinite(amount) && amount > 0) prices.push({ amount, currency });
  };
  const visit = (node: unknown) => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== 'object') return;
    const item = node as Record<string, unknown>;
    const type = String(item['@type'] ?? '');
    if (/Offer/.test(type)) {
      add(item.price ?? item.lowPrice, item.priceCurrency);
      availability ??= availabilityOf(item.availability);
    }
    for (const value of Object.values(item)) if (value && typeof value === 'object') visit(value);
  };
  for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { visit(JSON.parse(match[1].trim())); } catch { /* A broken block does not hide the others. */ }
  }
  const meta = (names: string[]) => {
    for (const name of names) {
      const tag = html.match(new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${name.replace(/[.:]/g, '\\$&')}["'][^>]*>`, 'i'))?.[0];
      const content = tag?.match(/content=["']([^"']*)["']/i)?.[1];
      if (content) return decodeHtmlEntities(content);
    }
    return null;
  };
  if (!prices.length) add(meta(['product:price:amount', 'og:price:amount', 'price']), meta(['product:price:currency', 'og:price:currency', 'priceCurrency']));
  availability ??= availabilityOf(meta(['product:availability', 'og:availability', 'availability'])
    ?? html.match(/itemprop=["']availability["'][^>]*(?:href|content)=["']([^"']+)["']/i)?.[1]);
  const text = decodeHtmlEntities(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
  return { prices, availability, text };
}

const SYMBOLS: Partial<Record<Currency, string[]>> = {
  EUR: ['€'], GBP: ['£'], USD: ['$', 'US$'], CLP: ['$'], MXN: ['$'], ARS: ['$'], COP: ['$'], AUD: ['$', 'A$'],
  CAD: ['$', 'C$'], NZD: ['$'], SGD: ['$', 'S$'], HKD: ['$', 'HK$'], JPY: ['¥', '円'], CNY: ['¥', '元'], INR: ['₹'], BRL: ['R$'], KRW: ['₩'],
};
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether the visible page text shows this amount next to a marker of its currency. */
export function textShowsPrice(text: string, amount: number, currency: Currency): boolean {
  const whole = Math.trunc(amount);
  const grouped = (sep: string) => String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  const cents = Math.round((amount - whole) * 100);
  const numbers = [...new Set(['', '.', ',', ' ', ' ', "'"].map(grouped))]
    .flatMap(n => cents ? [`${n}.${String(cents).padStart(2, '0')}`, `${n},${String(cents).padStart(2, '0')}`] : [n, `${n}.00`, `${n},00`, `${n},-`]);
  const markers = [currency, ...(SYMBOLS[currency] ?? [])].map(escape).join('|');
  const amounts = numbers.map(escape).join('|');
  return new RegExp(`(?:${markers})\\s?(?:${amounts})(?![\\d])|(?<![\\d.,])(?:${amounts})\\s?(?:${markers})`, 'i').test(text);
}

/**
 * On a readable page, keeps a price only when the page shows it (a single structured
 * page price replaces the extracted one) and stock only when the page states it. On an
 * unreadable page, the price stays but is marked unconfirmed.
 */
export function applyPageEvidence(offer: Offer, evidence: PageEvidence | null, at = new Date().toISOString()): { offer: Offer; outcome: 'confirmed' | 'corrected' | 'unconfirmed' } {
  const next: Offer = structuredClone(offer);
  next.availability = evidence?.availability ?? (offer.availability === 'available' ? 'unknown' : offer.availability);
  const missing = new Set(next.missing.filter(m => m !== UNCONFIRMED_PRICE));
  if (next.availability === 'unknown') missing.add('Availability');
  // Pages often list related products too: confirm an extracted price that the page
  // lists, and replace it only when the page has a single unambiguous price.
  const pagePrices = [...new Map((evidence?.prices ?? []).map(p => [`${p.currency} ${p.amount}`, p])).values()];
  const structured = pagePrices.find(p => p.currency === offer.price.currency && Math.round(p.amount * 100) === offer.price.amountCents)
    ?? (pagePrices.length === 1 ? pagePrices[0] : undefined);
  // Many storefronts block server requests. When the page cannot be read at all, the
  // extracted price stays visible but is labelled as unconfirmed; stock stays unknown.
  if (!evidence) {
    next.priceSource = 'unconfirmed';
    if (offer.price.amountCents !== null) missing.add(UNCONFIRMED_PRICE);
    next.missing = [...missing];
    return { offer: next, outcome: 'unconfirmed' };
  }
  const unconfirmed = () => {
    next.price = { currency: offer.price.currency, amountCents: null };
    next.priceSource = 'unconfirmed';
    missing.add(UNCONFIRMED_PRICE);
    next.missing = [...missing];
    return { offer: next, outcome: 'unconfirmed' as const };
  };
  if (structured) {
    const amountCents = Math.round(structured.amount * 100);
    const same = structured.currency === offer.price.currency && amountCents === offer.price.amountCents;
    next.price = { currency: structured.currency, amountCents };
    next.priceSource = 'seller_page';
    missing.delete('Final listed price');
    if (!same) next.evidence = [...next.evidence, { sourceType: 'url', ref: offer.provenanceUrl, snippet: `Seller page lists ${structured.currency} ${structured.amount}`, at }];
    next.missing = [...missing];
    return { offer: next, outcome: same ? 'confirmed' : 'corrected' };
  }
  if (evidence && offer.price.amountCents !== null && textShowsPrice(evidence.text, offer.price.amountCents / 100, offer.price.currency)) {
    next.priceSource = 'seller_page';
    next.missing = [...missing];
    return { offer: next, outcome: 'confirmed' };
  }
  return unconfirmed();
}

/** Reads each live offer's seller page once and applies what it shows; fixtures pass through. */
export function offerVerifier(read: PageReader = readPage, signal?: AbortSignal) {
  const pages = new Map<string, Promise<PageEvidence | null>>();
  const evidenceFor = (url: string) => {
    let cached = pages.get(url);
    if (!cached) {
      const bounded = AbortSignal.timeout(PAGE_CHECK_TIMEOUT_MS);
      cached = read(url, signal ? AbortSignal.any([signal, bounded]) : bounded)
        .then(page => page ? pagePriceEvidence(page.html) : null).catch(() => null);
      pages.set(url, cached);
    }
    return cached;
  };
  return async (offer: Offer): Promise<Offer> => {
    if (offer.mode !== 'live') return offer;
    const started = Date.now();
    const evidence = await evidenceFor(offer.provenanceUrl);
    const { offer: checked, outcome } = applyPageEvidence(offer, evidence);
    let domain: string | undefined;
    try { domain = new URL(offer.provenanceUrl).hostname; } catch { domain = undefined; }
    recordDiagnostic(`offer.verification.${outcome}`, outcome === 'unconfirmed' ? 'warn' : 'info', {
      ...(domain ? { domain } : {}), durationMs: Date.now() - started,
      ...(outcome === 'unconfirmed' ? { reason: evidence ? 'not_on_page' as const : 'unavailable' as const } : {}),
    });
    return checked;
  };
}
