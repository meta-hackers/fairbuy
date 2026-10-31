import { computeTotal, type Product, type ShoppingSession } from '@fairbuy/core';
import { money, ProductGlyph } from './ProductCard';
export default function Buy({ product, session, onBack }: { product: Product; session: ShoppingSession; onBack: () => void }) {
  return <section><button className="text-button back-button" onClick={onBack}>← Back to discovery</button>
    <div className="buy-intro panel"><ProductGlyph category={session.config.category ?? ''} small /><div><span className="eyebrow">THE ONE YOU CHOSE</span><h2>{product.name}</h2><p className="muted">{product.summary}</p></div></div>
    <div className="notice"><span aria-hidden="true">↗</span><p>FairBuy never checks out for you. Verify the exact model, delivered price, stock, warranty and returns on the seller’s site before paying. Nothing has been purchased.</p></div>
    <div className="seller-grid">{product.offers.map(offer => {
      const total = computeTotal(offer.price);
      const ranked = session.rounds.at(-1)?.ranking;
      const exclusion = ranked?.excluded.find(e => e.offerId === offer.id);
      return <article className="seller-card panel" key={offer.id}><div className="section-heading"><h3>{offer.seller}</h3><span className="tag">{offer.mode === 'fixture' ? 'Synthetic' : 'Search evidence'}</span></div>
        <strong className="seller-total">{total.isLowerBound ? 'At least ' : ''}{money(total.cents, offer.price.currency)}</strong><p className="micro">{total.isLowerBound ? 'Known minimum, not a delivered total' : 'Known delivered total · recheck with the seller'}</p>
        <dl className="seller-facts">{offer.price.components.map((c, i) => <div key={i}><dt>{c.label || (c.kind === 'other' ? 'Taxes / fees' : c.kind.charAt(0).toUpperCase() + c.kind.slice(1))}</dt><dd>{c.status === 'unknown' ? 'Unknown' : money(c.amountCents, offer.price.currency)}</dd></div>)}
          <div><dt>Availability</dt><dd>{offer.availability.replace('_', ' ')}{offer.mode === 'live' && ' · unverified'}</dd></div><div><dt>Condition</dt><dd>{offer.condition.status === 'unknown' ? 'Unknown' : `${offer.condition.value} · ${offer.condition.status.replace('_', ' ')}`}</dd></div>
          <div><dt>Warranty / returns</dt><dd>Check with seller</dd></div><div><dt>Delivery date</dt><dd>Check with seller</dd></div></dl>
        {exclusion && <p className="warning-text">Does not meet this brief: {exclusion.reasons.join('; ')}</p>}
        {!!offer.missing.length && <p className="micro">Missing: {offer.missing.join(', ')}.</p>}
        <p className="micro">{offer.mode === 'fixture' ? 'Fictional catalog timestamp' : 'Retrieved'} {new Date(offer.fetchedAt).toLocaleString()}</p>
        {offer.mode === 'live' && /^https:\/\//.test(offer.provenanceUrl) ? <a className="button primary seller-link" href={offer.provenanceUrl} target="_blank" rel="noopener noreferrer">Check at seller ↗</a> : <p className="fixture-link-note">Fictional seller — no purchase link</p>}
      </article>;
    })}</div>
  </section>;
}
