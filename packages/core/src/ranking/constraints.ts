import { TOTAL_ATTRIBUTE, type CategorySpec, type Constraint, type Offer } from "../contract";
import { computeTotal } from "./total";

// "unknown" is never a pass: missing data must not be treated as a positive result.
export type Outcome = "pass" | "fail" | "unknown";

export interface ConstraintResult {
  constraint: Constraint;
  outcome: Outcome;
  reason: string;
}

export function evaluateConstraint(offer: Offer, constraint: Constraint, spec: CategorySpec): ConstraintResult {
  const result = (outcome: Outcome, reason: string): ConstraintResult => ({ constraint, outcome, reason });

  if (constraint.attribute === TOTAL_ATTRIBUTE) {
    if (typeof constraint.value !== "number" || constraint.op === "in") {
      return result("unknown", "unsupported constraint on total");
    }
    const total = computeTotal(offer.price);
    const passes = compareNumbers(total.cents, constraint.op, constraint.value);
    if (!total.isLowerBound) {
      return result(passes ? "pass" : "fail", `total ${formatCents(total.cents)} ${constraint.op} ${formatCents(constraint.value)}`);
    }
    // The real total is >= the known minimum: a minimum already over a cap is a sure fail,
    // a minimum that meets a floor is a sure pass, anything else stays unknown.
    if (constraint.op === ">=" && passes) {
      return result("pass", `known minimum ${formatCents(total.cents)} already meets ${formatCents(constraint.value)}`);
    }
    if (constraint.op !== ">=" && total.cents > constraint.value) {
      return result("fail", `known minimum ${formatCents(total.cents)} already exceeds ${formatCents(constraint.value)}`);
    }
    return result("unknown", `total is incomplete (known minimum ${formatCents(total.cents)})`);
  }

  const field = offer.attributes[constraint.attribute];
  if (!field || field.status === "unknown") {
    return result("unknown", `${constraint.attribute} is not stated`);
  }

  const attr = field.value;
  switch (attr.kind) {
    case "number": {
      if (typeof constraint.value !== "number" || constraint.op === "in") {
        return result("unknown", `constraint is not comparable with numeric ${constraint.attribute}`);
      }
      const expectedUnit = spec.attributes.find((a) => a.key === constraint.attribute)?.unit;
      if (expectedUnit && attr.unit !== expectedUnit) {
        // Conversions belong in a deterministic table; until we have one, refuse to guess.
        return result("unknown", `${constraint.attribute} is in ${attr.unit}, expected ${expectedUnit}`);
      }
      const passes = compareNumbers(attr.value, constraint.op, constraint.value);
      return result(passes ? "pass" : "fail", `${constraint.attribute} ${attr.value} ${constraint.op} ${constraint.value}`);
    }
    case "bool": {
      if (typeof constraint.value !== "boolean" || constraint.op !== "=") {
        return result("unknown", `constraint is not comparable with boolean ${constraint.attribute}`);
      }
      return result(attr.value === constraint.value ? "pass" : "fail", `${constraint.attribute} is ${attr.value}`);
    }
    case "enum":
    case "text": {
      if (constraint.op === "in" && Array.isArray(constraint.value)) {
        const passes = constraint.value.includes(attr.value);
        return result(passes ? "pass" : "fail", `${constraint.attribute} "${attr.value}" in [${constraint.value.join(", ")}]`);
      }
      if (constraint.op === "=" && typeof constraint.value === "string") {
        return result(attr.value === constraint.value ? "pass" : "fail", `${constraint.attribute} is "${attr.value}"`);
      }
      return result("unknown", `constraint is not comparable with ${attr.kind} ${constraint.attribute}`);
    }
  }
}

function compareNumbers(actual: number, op: "<=" | ">=" | "=", expected: number): boolean {
  if (op === ">=") return actual >= expected;
  if (op === "<=") return actual <= expected;
  return actual === expected;
}

function formatCents(cents: number): string {
  return `€${(cents / 100).toFixed(2)}`;
}
