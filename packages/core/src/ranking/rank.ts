// Deterministic feasibility filtering and ranking (PROPOSAL §7).
// Same offers + constraints + weights + RANKING_VERSION => same result.
import { TOTAL_ATTRIBUTE, type CategorySpec, type Constraint, type FieldStatus, type Offer } from "../contract";
import { evaluateConstraint, type ConstraintResult } from "./constraints";
import { computeTotal, type Total } from "./total";

export const RANKING_VERSION = "0.1.0-draft";

export interface Weights {
  cost: number;
  suitability: number;
  reliability: number;
}

// Illustrative weights from PROPOSAL §7, to validate with users.
export const DEFAULT_WEIGHTS: Weights = { cost: 0.5, suitability: 0.3, reliability: 0.2 };

// How much each kind of field contributes to data reliability.
// This measures how well-sourced the data is, not product quality.
const STATUS_RELIABILITY: Record<FieldStatus, number> = {
  verified: 1,
  seller_claim: 0.6,
  estimate: 0.4,
  unknown: 0,
};

// Score differences below this are reported as a tie instead of a false-precision win.
const TIE_THRESHOLD = 0.02;

export interface ScoreComponent {
  value: number; // normalized 0..1
  weight: number;
  contribution: number; // value * weight
}

export interface RankedOffer {
  rank: number;
  offerId: string;
  // "unverified": no hard constraint failed, but at least one could not be checked.
  status: "feasible" | "unverified";
  total: Total;
  score: number;
  breakdown: { cost: ScoreComponent; suitability: ScoreComponent; reliability: ScoreComponent };
  constraints: ConstraintResult[];
}

export interface ExcludedOffer {
  offerId: string;
  reasons: string[];
  constraints: ConstraintResult[];
}

export interface ComparisonResult {
  rankingVersion: string;
  weights: Weights;
  ranked: RankedOffer[];
  excluded: ExcludedOffer[];
  warnings: string[];
}

export interface RankInput {
  offers: Offer[];
  constraints: Constraint[];
  spec: CategorySpec;
  weights?: Weights;
}

export function rankOffers({ offers, constraints, spec, weights = DEFAULT_WEIGHTS }: RankInput): ComparisonResult {
  assertWeights(weights);

  const ranked: Omit<RankedOffer, "rank" | "score" | "breakdown">[] = [];
  const excluded: ExcludedOffer[] = [];

  // 1. Feasibility before scoring.
  for (const offer of offers) {
    const results = constraints.map((c) => evaluateConstraint(offer, c, spec));
    const hard = results.filter((r) => r.constraint.hard);
    const reasons = hard.filter((r) => r.outcome === "fail").map((r) => r.reason);
    if (offer.availability === "sold_out") reasons.unshift("sold out");

    if (reasons.length > 0) {
      excluded.push({ offerId: offer.id, reasons, constraints: results });
      continue;
    }
    const uncertain = hard.some((r) => r.outcome === "unknown") || offer.availability !== "available";
    ranked.push({ offerId: offer.id, status: uncertain ? "unverified" : "feasible", total: computeTotal(offer.price), constraints: results });
  }

  // 2. Score the remaining candidates.
  const totals = ranked.map((r) => r.total.cents);
  const minTotal = Math.min(...totals);
  const maxTotal = Math.max(...totals);
  const offersById = new Map(offers.map((o) => [o.id, o]));

  const scored = ranked.map((candidate) => {
    const offer = offersById.get(candidate.offerId)!;
    const cost = maxTotal === minTotal ? 1 : (maxTotal - candidate.total.cents) / (maxTotal - minTotal);
    const soft = candidate.constraints.filter((r) => !r.constraint.hard);
    const suitability = soft.length === 0 ? 1 : soft.filter((r) => r.outcome === "pass").length / soft.length;
    const reliability = dataReliability(offer, constraints);

    const breakdown = {
      cost: component(cost, weights.cost),
      suitability: component(suitability, weights.suitability),
      reliability: component(reliability, weights.reliability),
    };
    const score = round(breakdown.cost.contribution + breakdown.suitability.contribution + breakdown.reliability.contribution);
    return { ...candidate, score, breakdown };
  });

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      Number(a.status === "unverified") - Number(b.status === "unverified") ||
      a.offerId.localeCompare(b.offerId),
  );
  const result = scored.map((s, i) => ({ ...s, rank: i + 1 }));

  return { rankingVersion: RANKING_VERSION, weights, ranked: result, excluded, warnings: buildWarnings(result, offers) };
}

function dataReliability(offer: Offer, constraints: Constraint[]): number {
  const statuses: FieldStatus[] = [offer.condition.status, ...offer.price.components.map((c) => c.status)];
  const constrained = new Set(constraints.map((c) => c.attribute).filter((key) => key !== TOTAL_ATTRIBUTE));
  for (const key of constrained) {
    statuses.push(offer.attributes[key]?.status ?? "unknown");
  }
  // Every declared missing field counts as an unknown.
  for (const _ of offer.missing) statuses.push("unknown");

  return statuses.reduce((sum, s) => sum + STATUS_RELIABILITY[s], 0) / statuses.length;
}

function buildWarnings(ranked: RankedOffer[], offers: Offer[]): string[] {
  const warnings: string[] = [];
  if (offers.some((o) => o.mode === "fixture")) {
    warnings.push("Contains synthetic fixtures: not current offers.");
  }
  ranked.forEach((r, i) => {
    const next = ranked[i + 1];
    if (next && r.score - next.score < TIE_THRESHOLD) {
      warnings.push(`${r.offerId} and ${next.offerId} are effectively tied (score difference < ${TIE_THRESHOLD}).`);
    }
    // A missing cost can only push an offer down: it matters only if something ranks below it.
    if (r.total.isLowerBound && i < ranked.length - 1) {
      warnings.push(`${r.offerId} has an incomplete total and ranks above other offers: the ordering may change once the missing cost is known.`);
    }
  });
  return warnings;
}

function component(value: number, weight: number): ScoreComponent {
  return { value: round(value), weight, contribution: round(value * weight) };
}

function assertWeights(w: Weights): void {
  const values = [w.cost, w.suitability, w.reliability];
  if (values.some((v) => v < 0) || Math.abs(values.reduce((a, b) => a + b, 0) - 1) > 1e-9) {
    throw new Error("Weights must be non-negative and sum to 1.");
  }
}

function round(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
