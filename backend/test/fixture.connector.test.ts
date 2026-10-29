import { describe, expect, it } from "vitest";
import { FixtureConnector } from "../src/connectors/fixture.connector.js";

describe("FixtureConnector", () => {
  const connector = new FixtureConnector();

  it("returns only fixture-mode offers for a known category", async () => {
    const offers = await connector.search({ category: "laptop", constraints: [] });
    expect(offers).toHaveLength(3);
    expect(offers.every((o) => o.mode === "fixture")).toBe(true);
  });

  it("returns nothing for an unknown category", async () => {
    expect(await connector.search({ category: "bike", constraints: [] })).toEqual([]);
  });

  it("returns copies, not the shared fixtures", async () => {
    const [first] = await connector.search({ category: "laptop", constraints: [] });
    first!.title = "changed";
    const [again] = await connector.search({ category: "laptop", constraints: [] });
    expect(again!.title).not.toBe("changed");
  });

  it("returns a non-retryable error for an unknown reference", async () => {
    const result = await connector.fetch("fixture://laptop/missing");
    expect(result).toMatchObject({ type: "unreachable", retryable: false });
  });
});
