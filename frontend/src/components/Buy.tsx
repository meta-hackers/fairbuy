import type { Offer, Product, SellerSearch, ShoppingSession } from '@fairbuy/core';
import { money, ProductImage } from './ProductCard';

function SellerCard({ offer, session, sellerSearch }: { offer: Offer; session: ShoppingSession; sellerSearch: SellerSearch | null }) {
  const ranked = session.rounds.at(-1)?.ranking;
  const exclusion = ranked?.excluded.find(e => e.offerId === offer.id);
  const extra = sellerSearch?.offers.some(item => item.id === offer.id);
  return <article className="seller-card panel" data-testid="seller-card" key={offer.id}>
    <div className="section-heading"><h3>{offer.seller}</h3><span className="tag">{offer.mode === 'fixture' ? 'Synthetic' : extra ? 'Additional seller' : 'Search evidence'}</span></div>
    <strong className="seller-total">{offer.price.amountCents === null ? 'Final price not listed' : money(offer.price.amountCents, offer.price.currency)}</strong><p className="micro">{offer.price.amountCents === null ? 'The seller did not state a final item price' : 'Final listed price · shipping and delivery vary by location'}</p>
    <dl className="seller-facts"><div><dt>Price</dt><dd>{offer.price.amountCents === null ? 'Unknown' : money(offer.price.amountCents, offer.price.currency)} {offer.price.currency}</dd></div>
      <div><dt>Availability</dt><dd>{offer.availability.replace('_', ' ')}{offer.mode === 'live' && ' · unverified'}</dd></div><div><dt>Condition</dt><dd>{offer.condition.status === 'unknown' ? 'Unknown' : `${offer.condition.value} · ${offer.condition.status.replace('_', ' ')}`}</dd></div>
      <div><dt>Shipping / delivery</dt><dd>Check with seller for your location</dd></div><div><dt>Warranty / returns</dt><dd>Check with seller</dd></div></dl>
    {exclusion && <p className="warning-text">Does not meet this brief: {exclusion.reasons.join('; ')}</p>}
    {extra && <p className="micro">Found while checking this same model in your market. Your brief’s features were not re-scored for this offer.</p>}
    {!!offer.missing.length && <p className="micro">Missing: {offer.missing.join(', ')}.</p>}
    <p className="micro">{offer.mode === 'fixture' ? 'Fictional catalog timestamp' : 'Retrieved'} {new Date(offer.fetchedAt).toLocaleString()}</p>
    {offer.mode === 'live' && /^https:\/\//.test(offer.provenanceUrl) ? <a className="button primary seller-link" href={offer.provenanceUrl} target="_blank" rel="noopener noreferrer">Check at seller ↗</a> : <p className="fixture-link-note">Fictional seller — no purchase link</p>}
  </article>;
}
export default function Buy({ product, session, sellerSearch, onRetrySellerSearch, onBack }: {
  product: Product; session: ShoppingSession; sellerSearch: SellerSearch | null;
  onRetrySellerSearch: () => void; onBack: () => void;
}) {
  const extraOffers = (sellerSearch?.offers ?? []).filter(offer => !product.offers.some(existing => existing.id === offer.id));
  const offers = [...product.offers, ...extraOffers];
  const searching = !!sellerSearch && ['queued', 'running'].includes(sellerSearch.status);
  const complete = sellerSearch?.status === 'complete';
  const failed = sellerSearch?.status === 'failed';
  const country = session.config.country;
  return <section><button className="text-button back-button" onClick={onBack}>← Back to discovery</button>
    <div className="buy-intro panel"><ProductImage product={product} sessionId={session.id} category={session.config.category ?? ''} small /><div><span className="eyebrow">THE ONE YOU CHOSE</span><h2>{product.name}</h2><p className="muted">{product.summary}</p></div></div>
    <div className="notice"><span aria-hidden="true">↗</span><p>FairBuy never checks out for you. Verify the exact model, final price, stock, warranty and returns on the seller’s site before paying. Shipping and delivery depend on your location and are not estimated here. Nothing has been purchased.</p></div>
    <div className="seller-grid">{offers.map(offer => <SellerCard key={offer.id} offer={offer} session={session} sellerSearch={sellerSearch} />)}
      {searching && <article className="seller-card panel seller-card--searching" data-testid="seller-search-spinner" role="status" aria-live="polite">
        <div className="seller-search-state"><span className="spinner large" aria-hidden="true" /><div>
          <span className="eyebrow">SELLER {offers.length + 1} · SEARCHING</span>
          <h3>Looking for another seller.</h3>
          <p className="micro">{sellerSearch?.activities?.at(-1)?.message ?? `Checking ${country ?? 'your market'} stores for the exact same model. No features are re-scored.`}</p>
          <p className="micro">Same product and market only. The list will update as soon as another source-backed seller is found.</p>
        </div></div>
      </article>}
    </div>
    {complete && !extraOffers.length && <div className="notice"><span aria-hidden="true">◌</span><p>No other sellers of this exact model were found in {country ?? 'your market'}. Your existing seller list is unchanged. {sellerSearch.summary && <span className="micro">{sellerSearch.summary}</span>}</p></div>}
    {failed && <div className="error-banner" role="alert"><p>{sellerSearch.error} Your current sellers are still available. <button className="text-button" onClick={onRetrySellerSearch}>Search again ↻</button></p></div>}
    {complete && !!extraOffers.length && <p className="micro seller-search-summary">{sellerSearch.summary}</p>}
  </section>;
}
