import { useState } from 'react';
import { scorePoints, type Product, type RankedOffer } from '@fairbuy/core';
import { imageTraceId, reportClientEvent } from '../telemetry';
import { productIllustration } from '../productIllustrations';
export function money(cents: number, currency: string) { return new Intl.NumberFormat('en', { style: 'currency', currency, maximumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100); }
export function ProductGlyph({ category = '', small = false }: { category?: string; small?: boolean }) {
  const laptop = /laptop|computer|pc|notebook/i.test(category);
  return <div className={`product-glyph ${small ? 'product-glyph--small' : ''}`} aria-hidden="true"><svg viewBox="0 0 140 100" fill="none">
    {laptop ? <><rect x="28" y="16" width="84" height="58" rx="5" stroke="currentColor" strokeWidth="2" /><rect x="34" y="22" width="72" height="45" rx="2" fill="currentColor" opacity=".09" /><path d="m28 74-11 10c-2 2 0 5 4 5h98c4 0 6-3 4-5l-11-10H28Z" stroke="currentColor" strokeWidth="2"/><path d="M61 79h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></>
      : <><path d="m70 12 43 24v42l-43 20-43-20V36l43-24Z" stroke="currentColor" strokeWidth="2"/><path d="m27 36 43 23 43-23M70 59v39M49 24l43 23v18" stroke="currentColor" strokeWidth="2"/><path d="m27 36 43 23v39L27 78V36Z" fill="currentColor" opacity=".08" /></>}
  </svg></div>;
}
export function ProductIllustration({ category = '', name = '', small = false }: { category?: string; name?: string; small?: boolean }) {
  const src = productIllustration(category, name);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  return <div className={`product-illustration ${small ? 'product-illustration--small' : ''}`}>
    {failedSrc === src ? <ProductGlyph category={category} small={small} />
      : <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailedSrc(src)} />}
    <span className="product-illustration-label">AI illustration · not a product photo</span>
  </div>;
}
export function ProductImage({ product, sessionId, category, small = false }: { product: Product; sessionId: string; category?: string; small?: boolean }) {
  const [failedUrls, setFailedUrls] = useState<string[]>([]);
  // Recovery works for saved searches with no image URL, too. Change the request
  // when new evidence arrives so an earlier failed load does not stick forever.
  const version = JSON.stringify([product.imageUrl, product.offers.map(o => o.id)]);
  const traceId = imageTraceId(JSON.stringify([sessionId, product.id, version]));
  const recoverySrc = `/api/sessions/${sessionId}/products/${encodeURIComponent(product.id)}/image?v=${encodeURIComponent(version)}&traceId=${traceId}`;
  const preferredSrc = product.imageUrl ? `/api/image?url=${encodeURIComponent(product.imageUrl)}&sessionId=${sessionId}&productId=${encodeURIComponent(product.id)}&traceId=${traceId}` : null;
  // One trace connects the initial proxy load, recovery, and final browser error.
  const src = preferredSrc && !failedUrls.includes(preferredSrc) ? preferredSrc : recoverySrc;
  if (failedUrls.includes(src) || (!product.imageUrl && !product.offers.some(o => o.mode === 'live'))) return <ProductIllustration category={category ?? product.offers[0]?.category ?? ''} name={product.name} small={small} />;
  return <img className={`product-photo ${small ? 'product-photo--small' : ''}`} src={src} alt={`${product.name} product image`}
    loading="lazy" decoding="async" onError={() => {
      setFailedUrls(urls => [...urls.slice(-3), src]);
      if (src === recoverySrc) reportClientEvent({ kind: 'image_unavailable', sessionId, productId: product.id, traceId });
    }} />;
}
export default function ProductCard({ product, sessionId, ranked, index, onLearn, onSelect, busy }: {
  product: Product; sessionId: string; ranked: RankedOffer[]; index: number; onLearn: () => void; onSelect: () => void; busy: boolean;
}) {
  const best = ranked[0];
  const eligible = product.offers.filter(o => ranked.some(r => r.offerId === o.id));
  const prices = eligible.flatMap(o => o.price.amountCents === null ? [] : [o.price.amountCents]);
  const currency = eligible[0]?.price.currency ?? 'EUR';
  // Prices the server could not read on the seller page are labelled, never presented as confirmed.
  const unconfirmedPrice = eligible.some(o => o.priceSource === 'unconfirmed');
  const price = prices.length ? `${money(Math.min(...prices), currency)}${Math.max(...prices) > Math.min(...prices) ? ` – ${money(Math.max(...prices), currency)}` : ''}` : 'Final price not listed';
  const unknownPrices = eligible.length - prices.length;
  const sources = [...new Map(eligible.filter(o => /^https:\/\//.test(o.provenanceUrl)).map(o => [o.provenanceUrl, o])).values()];
  const points = scorePoints(best);
  const pct = (weight: number) => Math.round(weight * 100);
  const preferences = best.weights.suitability > 0;
  const scoreTitle = preferences
    ? `Deterministic score: ${pct(best.weights.cost)}% price, ${pct(best.weights.suitability)}% preferences, ${pct(best.weights.reliability)}% evidence reliability`
    : `Deterministic score: ${pct(best.weights.cost)}% price, ${pct(best.weights.reliability)}% evidence reliability. No preference could be checked automatically`;
  return <article className={`product-card ${index === 0 ? 'product-card--first' : ''}`} data-testid="product-card">
    <div className="product-visual"><span className="rank-index">{String(index + 1).padStart(2, '0')}</span><ProductImage product={product} sessionId={sessionId} />{index === 0 && <span className="top-pick">Best scored option</span>}</div>
    <div className="product-content">
      <div className="product-heading"><div><h2>{product.name}</h2><p className="micro">{[...new Set(eligible.map(o => o.seller))].join(' · ')}</p></div><span className="fit-score" title={scoreTitle}>{points.total}<small>/100 fit</small></span></div>
      <p className="product-summary">{product.summary}</p>
      <div className="why"><span aria-hidden="true">✳</span><p>{product.why}</p></div>
      <div className="product-tags"><span className="tag">{best.status === 'unverified' ? 'Checks still needed' : 'No known constraint failure'}</span>{(!best.price.known || unconfirmedPrice) && <span className="tag warning-tag">{unconfirmedPrice ? 'Price not confirmed on the seller page' : 'Price not listed'}</span>}</div>
      <div className="price-line"><div><strong>{price}</strong><span>{prices.length ? `Final listed price${prices.length === 1 ? '' : 's'} · ${prices.length} ${prices.length === 1 ? 'offer' : 'offers'}${unknownPrices ? ` · ${unknownPrices} not listed` : ''}${unconfirmedPrice ? ' · not confirmed on the seller page' : ''}` : unconfirmedPrice ? 'Price not confirmed on the seller page' : 'The seller has not stated a final price'}</span></div></div>
      {!!sources.length && <div className="inline-sources"><span>Sources:</span>{sources.map((o, i) => <a href={o.provenanceUrl} key={o.id} target="_blank" rel="noopener noreferrer">[{i + 1}] {o.seller} ↗</a>)}</div>}
      <details className="product-details"><summary>Trade-offs & evidence <span aria-hidden="true">+</span></summary>
        <ul>{product.tradeoffs.map((t, i) => <li key={i}>{t}</li>)}{best.constraints.map((r, i) => <li key={`c${i}`}><span className={`outcome outcome--${r.outcome}`}>{r.outcome === 'pass' ? '✓' : r.outcome === 'fail' ? '−' : '?'}</span>{r.reason}{r.constraint.hard && ' · must-have'}</li>)}</ul>
        <p className="micro">Score breakdown: price {points.cost}{preferences ? ` + preferences ${points.suitability}` : ''} + evidence {points.reliability} = {points.total}.{preferences ? '' : ' No preference could be checked automatically, so price and evidence carry the score.'} This is not a quality or safety guarantee. Shipping and delivery are not included.</p>
        {eligible.map(offer => <div className="offer-evidence" key={offer.id}><strong>{offer.seller}</strong>
          {Object.entries(offer.attributes).map(([key, field]) => <p className="micro" key={key}>{key}: {field.status === 'unknown' ? 'unknown' : `${field.value.value}${field.value.kind === 'number' ? ` ${field.value.unit}` : ''}`} · {field.status.replace('_', ' ')}</p>)}
          {offer.evidence[0]?.snippet && <blockquote>{offer.evidence[0].snippet}</blockquote>}
          <p className="micro">{offer.mode === 'fixture' ? 'Synthetic fixture timestamp' : 'Search retrieved'}: {new Date(offer.fetchedAt).toLocaleString()}. {offer.missing.length ? `Unknown: ${offer.missing.join(', ')}.` : ''}</p></div>)}
      </details>
      <div className="product-actions"><button className="button primary" onClick={onSelect} disabled={busy}>Purchase options <span aria-hidden="true">→</span></button><button className="text-button" onClick={onLearn} disabled={busy}>Not for me <span aria-hidden="true">↻</span></button></div>
    </div>
  </article>;
}
