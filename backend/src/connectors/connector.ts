import type { Constraint, ConnectorError, Offer } from "@fairbuy/core";

export interface SearchQuery {
  category: string;
  constraints: Constraint[];
}

// Conceptual connector contract from PROPOSAL §8. Every connector returns offers in
// the shared contract, with provenance and mode, and never marks a fact verified
// without recording its source.
export interface Connector {
  readonly id: string;
  readonly mode: Offer["mode"];
  search(query: SearchQuery): Promise<Offer[]>;
  fetch(sourceRef: string): Promise<Offer | ConnectorError>;
}

export const CONNECTOR = Symbol("CONNECTOR");
