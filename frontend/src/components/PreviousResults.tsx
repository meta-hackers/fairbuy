import { allProducts, type ShoppingSession } from '@fairbuy/core';
import { money, ProductImage } from './ProductCard';

export default function PreviousResults({ session, activeIds }: { session: ShoppingSession; activeIds: Set<string> }) {
  const products = allProducts(session).filter(product => !activeIds.has(product.id));
  if (!products.length) return null;
  const current = session.rounds.at(-1);
  return <details className="panel previous-results">
    <summary>Other discovered results ({products.length})</summary>
    <p className="muted">Nothing is lost when you refine your search. Earlier, rejected, and excluded results stay here for reference; they are not current recommendations.</p>
    <div className="previous-results-list">{products.map(product => {
      const feedback = session.feedback.filter(item => item.productId === product.id);
      const excluded = current?.ranking?.excluded.filter(item => product.offers.some(offer => offer.id === item.offerId)) ?? [];
      const inCurrentSearch = current?.products.some(item => item.id === product.id);
      const reason = feedback.length ? `Marked not for you: ${feedback.map(item => item.reason).join('; ')}`
        : excluded.length ? `Excluded from current recommendations: ${[...new Set(excluded.flatMap(item => item.reasons))].join('; ')}`
        : inCurrentSearch ? 'Not currently ranked. Kept for reference.' : 'From an earlier search. Not revalidated against your current brief.';
      return <article className="previous-result" data-testid="archived-product" key={product.id}>
        <div className="previous-result-heading"><ProductImage product={product} sessionId={session.id} small /><div><h2>{product.name}</h2><p className="micro">{reason}</p></div></div>
        <p>{product.summary}</p>
        <details className="product-details"><summary>Details & sources</summary>
          <p>{product.why}</p>
          <ul>{product.tradeoffs.map((tradeoff, index) => <li key={index}>{tradeoff}</li>)}</ul>
          {product.offers.map(offer => <div className="offer-evidence" key={offer.id}>
            <strong>{offer.seller} · {offer.price.amountCents === null ? 'Final price not listed' : money(offer.price.amountCents, offer.price.currency)}</strong>
            <p className="micro">Historical offer · retrieved {new Date(offer.fetchedAt).toLocaleString()}. Price and availability may have changed.</p>
            {/^https:\/\//.test(offer.provenanceUrl) && <a href={offer.provenanceUrl} target="_blank" rel="noopener noreferrer">View source ↗</a>}
            {offer.evidence.map((evidence, index) => evidence.snippet && <blockquote key={index}>{evidence.snippet}</blockquote>)}
          </div>)}
        </details>
      </article>;
    })}</div>
  </details>;
}
