import offerA from "../fixtures/laptop/offer-a.json";
import offerB from "../fixtures/laptop/offer-b.json";
import offerC from "../fixtures/laptop/offer-c.json";
import { OfferSchema, type Offer } from "./contract";

// Synthetic demo offers (PROPOSAL §4), validated against the contract on load.
// Every one has mode "fixture": never present them as current offers.
export const fixturesByCategory: Readonly<Record<string, readonly Offer[]>> = {
  laptop: [offerA, offerB, offerC].map((raw) => OfferSchema.parse(raw)),
};
