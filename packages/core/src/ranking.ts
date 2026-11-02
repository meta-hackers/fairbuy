// Based on Alessandro's deterministic engine; no model-generated match scores.
import { TOTAL_ATTRIBUTE, UNINTERPRETED_PREFIX, type CategorySpec, type Constraint, type FinalPrice, type Offer } from './contract';
export const RANKING_VERSION = '3.0.0';
/** The seller's final listed price. Unknown is not zero and earns no cost credit. */
export function finalPrice(price: FinalPrice) {
  return { cents: price.amountCents, known: price.amountCents !== null };
}
export interface ConstraintResult { constraint: Constraint; outcome: 'pass' | 'fail' | 'unknown'; reason: string }

function normalizeEnum(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// Seller pages, manufacturer pages and model summaries rarely use the exact
// wording stored in a brief. These groups cover the common watch/electronics
// synonyms without turning a hard equality check into an open-ended guess.
const ENUM_SYNONYMS: string[][] = [
  ['swiss', 'switzerland', 'swiss made', 'made in switzerland'],
  ['steel', 'stainless steel'],
  ['moonphase', 'moon phase'],
  ['manual', 'hand wound', 'manually wound', 'manual winding'],
  ['automatic', 'self winding'],
];

function enumMatches(actual: string, expected: string): boolean {
  const a = normalizeEnum(actual);
  const e = normalizeEnum(expected);
  if (!a || !e) return false;
  if (a === e || `${a} `.includes(`${e} `) || `${e} `.includes(`${a} `)) return true;
  const group = ENUM_SYNONYMS.find(values => values.some(value => `${a} `.includes(`${value} `)) && values.some(value => `${e} `.includes(`${value} `)));
  return Boolean(group);
}

function isBrandExclusion(constraint: Constraint): boolean {
  const attribute = constraint.attribute.toLowerCase();
  const value = String(constraint.value).trim().toLowerCase();
  return attribute === 'brandexcluded' || attribute === 'brandexclude' ||
    (attribute === 'brand' && /^(?:not|no|exclude|avoid)\b/.test(value));
}

export function evaluateConstraint(offer: Offer, constraint: Constraint, spec: CategorySpec): ConstraintResult {
  const result = (outcome: ConstraintResult['outcome'], reason: string): ConstraintResult => ({ constraint, outcome, reason });
  const compare = (actual: number, expected: number) => constraint.op === '>=' ? actual >= expected : constraint.op === '<=' ? actual <= expected : actual === expected;
  if (constraint.attribute === TOTAL_ATTRIBUTE) {
    if (typeof constraint.value !== 'number' || constraint.op === 'in') return result('unknown', 'Unsupported budget comparison');
    const price = finalPrice(offer.price);
    if (!price.known) return result('unknown', 'Final listed price is not stated');
    return result(compare(price.cents!, constraint.value) ? 'pass' : 'fail', `Final listed price ${compare(price.cents!, constraint.value) ? 'meets' : 'does not meet'} your budget`);
  }
  if (isBrandExclusion(constraint)) {
    const brandText = String(constraint.value).replace(/^(?:not|no|exclude|avoid)\b/i, '').trim().split(/\s[-–—]\s/)[0];
    const brand = normalizeEnum(brandText);
    if (!brand) return result('unknown', 'The excluded brand is not specified');
    const brandField = offer.attributes.brand;
    const statedBrand = brandField && brandField.status !== 'unknown' && brandField.value.kind === 'text' ? brandField.value.value : '';
    const haystack = normalizeEnum(`${offer.title} ${offer.seller} ${offer.provenanceUrl} ${statedBrand}`);
    const display = brand.charAt(0).toUpperCase() + brand.slice(1);
    return `${haystack} `.includes(`${brand} `)
      ? result('fail', `${display} is excluded by your requirements`)
      : result('pass', `${display} was not found in the offer metadata`);
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
    const matches = constraint.value.some(value => typeof value === 'string' && enumMatches(attr.value as string, value));
    return result(matches ? 'pass' : 'fail', `${constraint.attribute}: ${attr.value}`);
  }
  if (constraint.op === '=' && typeof constraint.value === typeof attr.value) {
    const matches = typeof attr.value === 'string' && typeof constraint.value === 'string'
      ? enumMatches(attr.value, constraint.value) : attr.value === constraint.value;
    return result(matches ? 'pass' : 'fail', `${constraint.attribute}: ${attr.value}`);
  }
  return result('unknown', `${constraint.attribute} cannot be compared reliably`);
}
type Components = { cost: number; suitability: number; reliability: number };
export interface RankedOffer {
  offerId: string; rank: number; status: 'feasible' | 'unverified'; score: number;
  price: ReturnType<typeof finalPrice>; constraints: ConstraintResult[];
  /** Weighted parts of `score`. `weights.suitability` is 0 when no preference can be checked. */
  breakdown: Components; weights: Components;
}
const WEIGHTS: Components = { cost: 0.3, suitability: 0.5, reliability: 0.2 };
// Without checkable preferences, their share is redistributed so the score keeps a 0–1 range.
const NO_PREFERENCE_WEIGHTS: Components = { cost: 0.6, suitability: 0, reliability: 0.4 };
// Live extraction yields seller claims, so a seller claim is the normal baseline, not a near-failure.
const EVIDENCE_WEIGHTS: Record<string, number> = { verified: 1, seller_claim: 0.9, estimate: 0.5, unknown: 0 };
const isUninterpreted = (constraint: Constraint) => constraint.attribute.startsWith(UNINTERPRETED_PREFIX);

/** Whole-number score parts (0–100) that always add up to the displayed score. */
export function scorePoints({ score, breakdown }: Pick<RankedOffer, 'score' | 'breakdown'>): Components & { total: number } {
  const keys = ['cost', 'suitability', 'reliability'] as const;
  const total = Math.round(score * 100);
  const points = { cost: 0, suitability: 0, reliability: 0 };
  for (const key of keys) points[key] = Math.floor(breakdown[key] * 100);
  let rest = total - keys.reduce((n, key) => n + points[key], 0);
  for (const key of [...keys].sort((a, b) => (breakdown[b] * 100 % 1) - (breakdown[a] * 100 % 1))) {
    if (rest <= 0) break;
    points[key]++; rest--;
  }
  return { ...points, total };
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
  // Unknown prices are never rewarded as the cheapest final price. Known prices
  // score relative to the cheapest, so a small price gap stays a small gap.
  const cheapest = Math.min(...candidates.filter(c => c.price.known).map(c => c.price.cents!));
  const round = (n: number) => Math.round(n * 10000) / 10000;
  // Requirements code cannot check never count as matched or as missing evidence.
  const checkable = constraints.filter(c => !isUninterpreted(c));
  const uncheckedPreferences = constraints.filter(c => !c.hard && isUninterpreted(c)).length;
  const weights = checkable.some(c => !c.hard) ? WEIGHTS : NO_PREFERENCE_WEIGHTS;
  const evidenceAttributes = [...new Set(checkable
    .filter(c => c.attribute !== TOTAL_ATTRIBUTE && c.attribute !== 'condition' && !isBrandExclusion(c))
    .map(c => c.attribute))];
  const ranked = candidates.map(({ offer, results, price }): RankedOffer => {
    const cost = !price.known ? 0 : price.cents === 0 ? 1 : cheapest / price.cents!;
    const soft = results.filter(r => !r.constraint.hard && !isUninterpreted(r.constraint));
    const suitability = soft.length ? soft.filter(r => r.outcome === 'pass').length / soft.length : 0;
    // Evidence covers the facts the ranking relies on; optional unknown details do not count against it.
    const values = [offer.condition.status, price.known ? 'seller_claim' : 'unknown', ...evidenceAttributes.map(key => offer.attributes[key]?.status ?? 'unknown')];
    const reliability = values.reduce((n, status) => n + (EVIDENCE_WEIGHTS[status] ?? 0), 0) / values.length;
    const breakdown = { cost: cost * weights.cost, suitability: suitability * weights.suitability, reliability: reliability * weights.reliability };
    return {
      offerId: offer.id, rank: 0,
      status: !price.known || offer.availability !== 'available' || results.some(r => r.constraint.hard && r.outcome === 'unknown') ? 'unverified' : 'feasible',
      score: round(breakdown.cost + breakdown.suitability + breakdown.reliability), price, constraints: results,
      breakdown: { cost: round(breakdown.cost), suitability: round(breakdown.suitability), reliability: round(breakdown.reliability) }, weights,
    };
  }).sort((a, b) => b.score - a.score || a.offerId.localeCompare(b.offerId)).map((r, i) => ({ ...r, rank: i + 1 }));
  return { rankingVersion: RANKING_VERSION, ranked, excluded, warnings: [
    ...(offers.some(o => o.mode === 'fixture') ? ['Synthetic examples — not current offers.'] : []),
    ...(ranked.some(r => !r.price.known) ? ['Some final listed prices are not stated. Unknown prices earn no cost credit.'] : []),
    ...(uncheckedPreferences ? [`${uncheckedPreferences === 1 ? '1 preference' : `${uncheckedPreferences} preferences`} cannot be checked automatically and ${uncheckedPreferences === 1 ? 'does' : 'do'} not affect scores.`] : []),
    ...(ranked.some((r, i) => ranked[i + 1] && Math.abs(r.score - ranked[i + 1].score) < 0.02) ? ['Close scores represent trade-offs, not a decisive winner.'] : []),
  ] };
}
