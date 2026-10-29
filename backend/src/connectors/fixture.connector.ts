import { Injectable } from "@nestjs/common";
import { fixturesByCategory, type ConnectorError, type Offer } from "@fairbuy/core";
import type { Connector, SearchQuery } from "./connector.js";

// Serves the synthetic demo offers from @fairbuy/core. Offers are cloned so that
// stored comparisons never share mutable state with the fixtures.
@Injectable()
export class FixtureConnector implements Connector {
  readonly id = "fixture";
  readonly mode = "fixture" as const;

  async search(query: SearchQuery): Promise<Offer[]> {
    return (fixturesByCategory[query.category] ?? []).map((offer) => structuredClone(offer));
  }

  async fetch(sourceRef: string): Promise<Offer | ConnectorError> {
    const offer = Object.values(fixturesByCategory)
      .flat()
      .find((o) => o.provenanceUrl === sourceRef || o.id === sourceRef);
    if (!offer) {
      return { type: "unreachable", at: new Date().toISOString(), retryable: false, message: "Unknown fixture reference." };
    }
    return structuredClone(offer);
  }
}
