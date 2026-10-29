import type { PriceBreakdown } from "../contract";

export interface Total {
  cents: number;
  // true when a known cost is missing or a component's amount is unknown.
  isLowerBound: boolean;
}

export function computeTotal(price: PriceBreakdown): Total {
  const cents = price.components.reduce((sum, c) => sum + c.amountCents, 0);
  const hasUnknownComponent = price.components.some((c) => c.status === "unknown");
  return { cents, isLowerBound: price.totalIsLowerBound || hasUnknownComponent };
}
