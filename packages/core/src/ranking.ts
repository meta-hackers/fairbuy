// Based on Alessandro's deterministic engine; no model-generated match scores.
import { TOTAL_ATTRIBUTE, type CategorySpec, type Constraint, type FinalPrice, type Offer } from './contract';
export const RANKING_VERSION = '2.0.0';
/** The seller's final listed price. Unknown is not zero and earns no cost credit. */
export function finalPrice(price: FinalPrice) {
  return { cents: price.amountCents, known: price.amountCents !== null };
}
export interface ConstraintResult { constraint: Constraint; outcome: 'pass' | 'fail' | 'unknown'; reason: string }
export function evaluateConstraint(offer: Offer, constraint: Constraint, spec: CategorySpec): ConstraintResult {
  const result = (outcome: ConstraintResult['outcome'], reason: string): ConstraintResult => ({ constraint, outcome, reason });
  const compare = (actual: number, expected: number) => constraint.op === '>=' ? actual >= expected : constraint.op === '<=' ? actual <= expected : actual === expected;
  if (constraint.attribute === TOTAL_ATTRIBUTE) {
    if (typeof constraint.value !== 'number' || constraint.op === 'in') return result('unknown', 'Unsupported budget comparison');
    const price = finalPrice(offer.price);
    if (!price.known) return result('unknown', 'Final listed price is not stated');
    return result(compare(price.cents!, constraint.value) ? 'pass' : 'fail', `Final listed price ${compare(price.cents!, constraint.value) ? 'meets' : 'does not meet'} your budget`);
  }
  const field = constraint.attribute === 'condition' ? offer.condition : offer.attributes[constraint.attribute];
  if (!field || field.status === 'unknown') return result('unknown', `${constraint.attribute} is not stated`);
  const attr = typeof field.value === 'string' ? { kind: 'enum' as const, value: field.value } : field.value;
  if (attr.kind === 'number' && typeof constraint.value === 'number' && constraint.op !== 'in') {
    const unit = spec.attributes.find(a => a.key === constraint.attribute)?.unit;
    if (unit && attr.unit !== unit) return result('unknown', `${constraint.attribute}: incompatible units`);
    return result(compare(attr.value, constraint.value) ? 'pass' : 'fail', `${constraint.attribute}: ${attr.value} ${attr.unit} (wanted ${constraint.op} ${constraint.value})`);
  }
  if (constraint.op === 'in' && Array.isArray(constraint.value) && typeof attr.value === 'string') {
    return result(constraint.value.includes(attr.value) ? 'pass' : 'fail', `${constraint.attribute}: ${attr.value}`);
  }
  if (constraint.op === '=' && typeof constraint.value === typeof attr.value) {
    const matches = typeof attr.value === 'string' && typeof constraint.value === 'string'
      ? attr.value.toLowerCase() === constraint.value.toLowerCase() : attr.value === constraint.value;
    return result(matches ? 'pass' : 'fail', `${constraint.attribute}: ${attr.value}`);
  }
  return result('unknown', `${constraint.attribute} cannot be compared reliably`);
}
export interface RankedOffer {
  offerId: string; rank: number; status: 'feasible' | 'unverified'; score: number;
  price: ReturnType<typeof finalPrice>; constraints: ConstraintResult[];
  breakdown: { cost: number; suitability: number; reliability: number };
}
export interface ComparisonResult {
  rankingVersion: string; ranked: RankedOffer[];
  excluded: { offerId: string; reasons: string[] }[]; warnings: string[];
}
export function rankOffers({ offers, constraints, spec, currency }: {
  offers: Offer[]; constraints: Constraint[]; spec: CategorySpec; currency: string;
}): ComparisonResult {
  const excluded: ComparisonResult['excluded'] = [];
  const candidates = offers.flatMap(offer => {
    const results = constraints.map(c => evaluateConstraint(offer, c, spec));
    const reasons = results.filter(r => r.constraint.hard && r.outcome === 'fail').map(r => r.reason);
    if (offer.availability === 'sold_out') reasons.push('Sold out');
    if (offer.price.currency !== currency) reasons.push(`Different currency (${offer.price.currency}); no exchange rate assumed`);
    if (reasons.length) { excluded.push({ offerId: offer.id, reasons }); return []; }
    return [{ offer, results, price: finalPrice(offer.price) }];
  });
  // Unknown prices are never rewarded as the cheapest final price.
  const known = candidates.filter(c => c.price.known).map(c => c.price.cents!);
  const min = Math.min(...known), max = Math.max(...known);
  const round = (n: number) => Math.round(n * 10000) / 10000;
  const ranked = candidates.map(({ offer, results, price }): RankedOffer => {
    const cost = !price.known ? 0 : max === min ? 1 : (max - price.cents!) / (max - min);
    const soft = results.filter(r => !r.constraint.hard);
    const suitability = soft.length ? soft.filter(r => r.outcome === 'pass').length / soft.length : 0.5;
    const values = [offer.condition.status, price.known ? 'seller_claim' : 'unknown', ...constraints.filter(c => c.attribute !== 'total').map(c => offer.attributes[c.attribute]?.status ?? 'unknown')];
    const reliabilityWeights: Record<string, number> = { verified: 1, seller_claim: 0.6, estimate: 0.3, unknown: 0 };
    const reliability = values.reduce((n, status) => n + (reliabilityWeights[status] ?? 0), 0) / Math.max(1, values.length + offer.missing.length);
    return {
      offerId: offer.id, rank: 0,
      status: !price.known || offer.availability !== 'available' || results.some(r => r.constraint.hard && r.outcome === 'unknown') ? 'unverified' : 'feasible',
      score: round(cost * 0.3 + suitability * 0.5 + reliability * 0.2), price, constraints: results,
      breakdown: { cost: round(cost * 0.3), suitability: round(suitability * 0.5), reliability: round(reliability * 0.2) },
    };
  }).sort((a, b) => b.score - a.score || a.offerId.localeCompare(b.offerId)).map((r, i) => ({ ...r, rank: i + 1 }));
  return { rankingVersion: RANKING_VERSION, ranked, excluded, warnings: [
    ...(offers.some(o => o.mode === 'fixture') ? ['Synthetic examples — not current offers.'] : []),
    ...(ranked.some(r => !r.price.known) ? ['Some final listed prices are not stated. Unknown prices earn no cost credit.'] : []),
    ...(ranked.some((r, i) => ranked[i + 1] && Math.abs(r.score - ranked[i + 1].score) < 0.02) ? ['Close scores represent trade-offs, not a decisive winner.'] : []),
  ] };
}
