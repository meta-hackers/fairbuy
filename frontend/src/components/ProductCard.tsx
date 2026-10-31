import { computeTotal, type Product, type RankedOffer } from '@fairbuy/core';
export function money(cents: number, currency: string) { return new Intl.NumberFormat('en', { style: 'currency', currency, maximumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100); }
export function ProductGlyph({ category = '', small = false }: { category?: string; small?: boolean }) {
  const laptop = /laptop|computer|pc|notebook/i.test(category);
  return <div className={`product-glyph ${small ? 'product-glyph--small' : ''}`} aria-hidden="true"><svg viewBox="0 0 140 100" fill="none">
    {laptop ? <><rect x="28" y="16" width="84" height="58" rx="5" stroke="currentColor" strokeWidth="2" /><rect x="34" y="22" width="72" height="45" rx="2" fill="currentColor" opacity=".09" /><path d="m28 74-11 10c-2 2 0 5 4 5h98c4 0 6-3 4-5l-11-10H28Z" stroke="currentColor" strokeWidth="2"/><path d="M61 79h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></>
      : <><path d="m70 12 43 24v42l-43 20-43-20V36l43-24Z" stroke="currentColor" strokeWidth="2"/><path d="m27 36 43 23 43-23M70 59v39M49 24l43 23v18" stroke="currentColor" strokeWidth="2"/><path d="m27 36 43 23v39L27 78V36Z" fill="currentColor" opacity=".08" /></>}
  </svg></div>;
}
export default function ProductCard({ product, ranked, index, onLearn, onSelect, busy }: {
  product: Product; ranked: RankedOffer[]; index: number; onLearn: () => void; onSelect: () => void; busy: boolean;
}) {
  const best = ranked[0];
  const eligible = product.offers.filter(o => ranked.some(r => r.offerId === o.id));
  const complete = eligible.filter(o => !computeTotal(o.price).isLowerBound);
  const totals = complete.map(o => computeTotal(o.price).cents);
  const currency = eligible[0]?.price.currency ?? 'EUR';
  const price = complete.length ? `${money(Math.min(...totals), currency)}${Math.max(...totals) > Math.min(...totals) ? ` – ${money(Math.max(...totals), currency)}` : ''}` : 'Delivered total unknown';
  const sources = [...new Map(eligible.filter(o => /^https:\/\//.test(o.provenanceUrl)).map(o => [o.provenanceUrl, o])).values()];
  return <article className={`product-card ${index === 0 ? 'product-card--first' : ''}`} data-testid="product-card">
    <div className="product-visual"><span className="rank-index">{String(index + 1).padStart(2, '0')}</span><ProductGlyph category={product.offers[0]?.category} />{index === 0 && <span className="top-pick">Best scored option</span>}</div>
    <div className="product-content">
      <div className="product-heading"><div><h2>{product.name}</h2><p className="micro">{[...new Set(eligible.map(o => o.seller))].join(' · ')}</p></div><span className="fit-score" title="Deterministic score: 30% cost, 50% preferences, 20% evidence reliability">{Math.round(best.score * 100)}<small>/100 fit</small></span></div>
      <p className="product-summary">{product.summary}</p>
      <div className="why"><span aria-hidden="true">✳</span><p>{product.why}</p></div>
      <div className="product-tags"><span className="tag">{best.status === 'unverified' ? 'Checks still needed' : 'No known constraint failure'}</span>{best.total.isLowerBound && <span className="tag warning-tag">Incomplete total</span>}</div>
      <div className="price-line"><div><strong>{price}</strong><span>{complete.length ? `Known delivered totals · ${complete.length} ${complete.length === 1 ? 'offer' : 'offers'}` : 'Item price and charges may be missing'}</span></div></div>
      {!!sources.length && <div className="inline-sources"><span>Sources:</span>{sources.map((o, i) => <a href={o.provenanceUrl} key={o.id} target="_blank" rel="noopener noreferrer">[{i + 1}] {o.seller} ↗</a>)}</div>}
      <details className="product-details"><summary>Trade-offs & evidence <span aria-hidden="true">+</span></summary>
        <ul>{product.tradeoffs.map((t, i) => <li key={i}>{t}</li>)}{best.constraints.map((r, i) => <li key={`c${i}`}><span className={`outcome outcome--${r.outcome}`}>{r.outcome === 'pass' ? '✓' : r.outcome === 'fail' ? '−' : '?'}</span>{r.reason}{r.constraint.hard && ' · must-have'}</li>)}</ul>
        <p className="micro">Score breakdown: cost {Math.round(best.breakdown.cost * 100)} + preferences {Math.round(best.breakdown.suitability * 100)} + evidence {Math.round(best.breakdown.reliability * 100)}. This is not a quality or safety guarantee.</p>
        {eligible.map(offer => <div className="offer-evidence" key={offer.id}><strong>{offer.seller}</strong>
          {Object.entries(offer.attributes).map(([key, field]) => <p className="micro" key={key}>{key}: {field.status === 'unknown' ? 'unknown' : `${field.value.value}${field.value.kind === 'number' ? ` ${field.value.unit}` : ''}`} · {field.status.replace('_', ' ')}</p>)}
          {offer.evidence[0]?.snippet && <blockquote>{offer.evidence[0].snippet}</blockquote>}
          <p className="micro">{offer.mode === 'fixture' ? 'Synthetic fixture timestamp' : 'Search retrieved'}: {new Date(offer.fetchedAt).toLocaleString()}. {offer.missing.length ? `Unknown: ${offer.missing.join(', ')}.` : ''}</p></div>)}
      </details>
      <div className="product-actions"><button className="button primary" onClick={onSelect} disabled={busy}>Purchase options <span aria-hidden="true">→</span></button><button className="text-button" onClick={onLearn} disabled={busy}>Not for me <span aria-hidden="true">↻</span></button></div>
    </div>
  </article>;
}
