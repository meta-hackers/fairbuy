import { describe, expect, it, vi } from 'vitest';
import type { Offer } from '@fairbuy/core';
import { UNCONFIRMED_PRICE, applyPageEvidence, offerVerifier, pagePriceEvidence, parsePageAmount, textShowsPrice } from '../src/offer-verification';

const offer = (amountCents: number | null, extra: Partial<Offer> = {}): Offer => ({
  schemaVersion: 1, id: 'o', category: 'battery', mode: 'live', provenanceUrl: 'https://chile.desertcart.com/products/1', fetchedAt: '2026-11-04T00:00:00.000Z',
  availability: 'available', title: 'GoPro Enduro Battery', seller: 'Desertcart Chile', condition: { status: 'unknown' },
  price: { currency: 'CLP', amountCents }, attributes: {}, missing: [],
  evidence: [{ sourceType: 'url', ref: 'https://chile.desertcart.com/products/1', snippet: 'Price: 69857.00 CLP', at: '2026-11-04T00:00:00.000Z' }],
  ...extra,
});

describe('reading prices from seller pages (issue #40)', () => {
  it('parses local number formats as major units', () => {
    expect(parsePageAmount('69857')).toBe(69857);
    expect(parsePageAmount('69857.00')).toBe(69857);
    expect(parsePageAmount('69.857')).toBe(69857);
    expect(parsePageAmount('$ 1.299,90')).toBe(1299.9);
    expect(parsePageAmount('1,299.90')).toBe(1299.9);
    expect(parsePageAmount('n/a')).toBeNull();
  });

  it('reads JSON-LD, meta tags and microdata', () => {
    expect(pagePriceEvidence('<script type="application/ld+json">{"@graph":[{"@type":"Product","offers":{"@type":"Offer","price":"24990","priceCurrency":"CLP","availability":"https://schema.org/InStock"}}]}</script>'))
      .toMatchObject({ prices: [{ amount: 24990, currency: 'CLP' }], availability: 'available' });
    expect(pagePriceEvidence('<meta property="product:price:amount" content="24.990"><meta property="product:price:currency" content="CLP">'))
      .toMatchObject({ prices: [{ amount: 24990, currency: 'CLP' }], availability: null });
    expect(pagePriceEvidence('<link itemprop="availability" href="https://schema.org/OutOfStock">').availability).toBe('sold_out');
    expect(pagePriceEvidence('<script type="application/ld+json">{broken</script><p>No price</p>').prices).toEqual([]);
  });

  it('finds an amount in the visible text only next to its currency', () => {
    expect(textShowsPrice('Precio $69.857 IVA incluido', 69857, 'CLP')).toBe(true);
    expect(textShowsPrice('Price: CLP 69,857', 69857, 'CLP')).toBe(true);
    expect(textShowsPrice('Ref. 69857 · out of stock', 69857, 'CLP')).toBe(false);
    expect(textShowsPrice('€ 1.299,90', 1299.9, 'EUR')).toBe(true);
  });
});

describe('applying page evidence to an offer', () => {
  it('labels the price of an unreadable page and stops claiming stock', () => {
    const { offer: checked, outcome } = applyPageEvidence(offer(6985700), null);
    expect(outcome).toBe('unconfirmed');
    expect(checked).toMatchObject({ price: { currency: 'CLP', amountCents: 6985700 }, priceSource: 'unconfirmed', availability: 'unknown' });
    expect(checked.missing).toEqual(expect.arrayContaining([UNCONFIRMED_PRICE, 'Availability']));
  });

  it('drops a price that a readable page does not show', () => {
    const { offer: checked, outcome } = applyPageEvidence(offer(6985700), pagePriceEvidence('<p>Agotado. Ref. 69857</p>'));
    expect(outcome).toBe('unconfirmed');
    expect(checked).toMatchObject({ price: { currency: 'CLP', amountCents: null }, priceSource: 'unconfirmed', availability: 'unknown' });
  });

  it('never corrects to an ambiguous page price', () => {
    const page = pagePriceEvidence('<script type="application/ld+json">[{"@type":"Offer","price":"4.65","priceCurrency":"CHF"},{"@type":"Offer","price":"12.90","priceCurrency":"CHF"}]</script>');
    const checked = applyPageEvidence(offer(785, { price: { currency: 'CHF', amountCents: 785 } }), page);
    expect(checked).toMatchObject({ outcome: 'unconfirmed', offer: { price: { amountCents: null } } });
    expect(applyPageEvidence(offer(1290, { price: { currency: 'CHF', amountCents: 1290 } }), page).outcome).toBe('confirmed');
  });

  it('keeps a price the visible text shows, and takes the page price when structured data differs', () => {
    expect(applyPageEvidence(offer(6985700), pagePriceEvidence('<p>Precio: $69.857</p>'))).toMatchObject({ outcome: 'confirmed', offer: { priceSource: 'seller_page', price: { amountCents: 6985700 } } });
    const corrected = applyPageEvidence(offer(6985700), pagePriceEvidence('<script type="application/ld+json">{"@type":"Offer","price":"24990","priceCurrency":"CLP"}</script>'));
    expect(corrected).toMatchObject({ outcome: 'corrected', offer: { price: { currency: 'CLP', amountCents: 2499000 }, priceSource: 'seller_page' } });
    expect(corrected.offer.evidence.at(-1)?.snippet).toBe('Seller page lists CLP 24990');
  });

  it('marks a page that says out of stock as sold out', () => {
    const page = pagePriceEvidence('<script type="application/ld+json">{"@type":"Offer","price":"69857","priceCurrency":"CLP","availability":"https://schema.org/OutOfStock"}</script>');
    expect(applyPageEvidence(offer(6985700), page).offer.availability).toBe('sold_out');
  });

  it('reads each page once and leaves synthetic fixtures alone', async () => {
    const read = vi.fn(async (url: string) => ({ url, html: '<p>CLP 69.857</p>' }));
    const verify = offerVerifier(read);
    await verify(offer(6985700)); await verify(offer(6985700, { id: 'o2' }));
    expect(read).toHaveBeenCalledTimes(1);
    const fixture = offer(6985700, { mode: 'fixture' });
    expect(await verify(fixture)).toBe(fixture);
  });
});
