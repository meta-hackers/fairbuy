import offerA from "../fixtures/laptop/offer-a.json";
import offerB from "../fixtures/laptop/offer-b.json";
import offerC from "../fixtures/laptop/offer-c.json";
import { OfferSchema, type Constraint, type Offer } from "../src";

// Parsing through the schema both validates the fixtures and gives them the contract types.
export const fixtures = {
  a: OfferSchema.parse(offerA),
  b: OfferSchema.parse(offerB),
  c: OfferSchema.parse(offerC),
};

export const rawFixtures = [offerA, offerB, offerC];

// The demo request (PROPOSAL §4): at least 16 GB RAM, max €700 delivered, charger preferred.
export const demoConstraints: Constraint[] = [
  { attribute: "ramGb", op: ">=", value: 16, hard: true },
  { attribute: "total", op: "<=", value: 70000, hard: true },
  { attribute: "chargerIncluded", op: "=", value: true, hard: false },
];

export function variant(base: Offer, id: string, change: (o: Offer) => void): Offer {
  const copy = structuredClone(base);
  copy.id = id;
  change(copy);
  return copy;
}
