import { describe, expect, it } from "vitest";
import { laptopSpec, rankOffers, type Constraint } from "../src";
import { demoConstraints, fixtures, variant } from "./helpers";

const spec = laptopSpec;

describe("demo scenario (PROPOSAL §4)", () => {
  const result = rankOffers({ offers: [fixtures.a, fixtures.b, fixtures.c], constraints: demoConstraints, spec });

  it("excludes B before scoring because RAM is below the hard minimum", () => {
    expect(result.excluded.map((e) => e.offerId)).toEqual(["fixture-b"]);
    expect(result.excluded[0]!.reasons).toEqual(["ramGb 8 >= 16"]);
  });

  it("ranks A first on total cost and suitability", () => {
    const [first] = result.ranked;
    expect(first!.offerId).toBe("fixture-a");
    expect(first!.status).toBe("feasible");
    expect(first!.total).toEqual({ cents: 60500, isLowerBound: false });
    expect(first!.score).toBe(0.9);
  });

  it("keeps C as unverified: its known minimum fits the budget but the total is incomplete", () => {
    const c = result.ranked.find((r) => r.offerId === "fixture-c")!;
    expect(c.status).toBe("unverified");
    expect(c.total).toEqual({ cents: 64800, isLowerBound: true });
    expect(c.constraints.find((r) => r.constraint.attribute === "total")!.outcome).toBe("unknown");
  });

  it("exposes every score component", () => {
    const a = result.ranked[0]!;
    expect(a.breakdown.cost).toEqual({ value: 1, weight: 0.5, contribution: 0.5 });
    expect(a.breakdown.suitability).toEqual({ value: 1, weight: 0.3, contribution: 0.3 });
    expect(a.breakdown.reliability).toEqual({ value: 0.5, weight: 0.2, contribution: 0.1 });
  });

  it("warns that the data is synthetic", () => {
    expect(result.warnings).toContain("Contains synthetic fixtures: not current offers.");
  });
});

describe("reproducibility", () => {
  it("returns the same result regardless of input order", () => {
    const forward = rankOffers({ offers: [fixtures.a, fixtures.b, fixtures.c], constraints: demoConstraints, spec });
    const backward = rankOffers({ offers: [fixtures.c, fixtures.b, fixtures.a], constraints: demoConstraints, spec });
    expect(backward.ranked).toEqual(forward.ranked);
  });
});

describe("unknown data", () => {
  it("does not pass a hard constraint when the attribute is unknown", () => {
    const noRam = variant(fixtures.a, "no-ram", (o) => {
      o.attributes.ramGb = { status: "unknown" };
    });
    const result = rankOffers({ offers: [noRam], constraints: demoConstraints, spec });
    expect(result.ranked[0]!.status).toBe("unverified");
  });

  it("does not compare values in a different unit", () => {
    const mb = variant(fixtures.a, "mb", (o) => {
      o.attributes.ramGb = { status: "seller_claim", value: { kind: "number", value: 16384, unit: "MB" }, evidence: [] };
    });
    const result = rankOffers({ offers: [mb], constraints: demoConstraints, spec });
    const ram = result.ranked[0]!.constraints.find((r) => r.constraint.attribute === "ramGb")!;
    expect(ram.outcome).toBe("unknown");
  });

  it("excludes an incomplete total whose known minimum already exceeds the budget", () => {
    const expensive = variant(fixtures.c, "expensive", (o) => {
      o.price.components[0]!.amountCents = 69000;
    });
    const result = rankOffers({ offers: [expensive], constraints: demoConstraints, spec });
    expect(result.excluded[0]!.offerId).toBe("expensive");
  });

  it("warns when an incomplete total ranks above another offer", () => {
    const cheapIncomplete = variant(fixtures.c, "cheap-incomplete", (o) => {
      o.price.components[0]!.amountCents = 40000;
    });
    const result = rankOffers({ offers: [fixtures.a, cheapIncomplete], constraints: [], spec });
    expect(result.ranked[0]!.offerId).toBe("cheap-incomplete");
    expect(result.warnings.some((w) => w.startsWith("cheap-incomplete has an incomplete total"))).toBe(true);
  });
});

describe("availability", () => {
  it("excludes sold-out offers", () => {
    const soldOut = variant(fixtures.a, "sold-out", (o) => {
      o.availability = "sold_out";
    });
    const result = rankOffers({ offers: [soldOut], constraints: demoConstraints, spec });
    expect(result.excluded[0]!.reasons).toContain("sold out");
  });

  it("marks stale offers as unverified", () => {
    const stale = variant(fixtures.a, "stale", (o) => {
      o.availability = "stale";
    });
    const result = rankOffers({ offers: [stale], constraints: demoConstraints, spec });
    expect(result.ranked[0]!.status).toBe("unverified");
  });
});

describe("ties and weights", () => {
  it("reports near-identical scores as a tie", () => {
    const twin = variant(fixtures.a, "fixture-a-twin", () => {});
    const result = rankOffers({ offers: [fixtures.a, twin], constraints: demoConstraints, spec });
    expect(result.warnings.some((w) => w.includes("effectively tied"))).toBe(true);
  });

  it("rejects weights that do not sum to 1", () => {
    expect(() =>
      rankOffers({ offers: [fixtures.a], constraints: [], spec, weights: { cost: 1, suitability: 1, reliability: 0 } }),
    ).toThrow();
  });

  it("lets the user change weights", () => {
    const constraints: Constraint[] = [];
    const costOnly = rankOffers({
      offers: [fixtures.a, fixtures.b],
      constraints,
      spec,
      weights: { cost: 1, suitability: 0, reliability: 0 },
    });
    expect(costOnly.ranked[0]!.offerId).toBe("fixture-b");
  });
});
