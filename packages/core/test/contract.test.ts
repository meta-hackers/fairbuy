import { describe, expect, it } from "vitest";
import { OfferSchema } from "../src";
import { fixtures, rawFixtures } from "./helpers";

describe("contract", () => {
  it("all fixtures satisfy the offer schema", () => {
    for (const raw of rawFixtures) {
      expect(OfferSchema.safeParse(raw).success).toBe(true);
    }
  });

  it("all fixtures are labeled as fixtures", () => {
    for (const offer of Object.values(fixtures)) {
      expect(offer.mode).toBe("fixture");
    }
  });

  it("rejects an offer without mode", () => {
    const { mode: _, ...withoutMode } = fixtures.a;
    expect(OfferSchema.safeParse(withoutMode).success).toBe(false);
  });

  it("rejects a known field without a value", () => {
    const broken = structuredClone(fixtures.a) as Record<string, unknown>;
    broken.condition = { status: "verified", evidence: [] };
    expect(OfferSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects fractional cents", () => {
    const broken = structuredClone(fixtures.a);
    broken.price.components[0]!.amountCents = 590.5;
    expect(OfferSchema.safeParse(broken).success).toBe(false);
  });
});
