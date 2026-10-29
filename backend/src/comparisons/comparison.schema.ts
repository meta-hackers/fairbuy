import { z } from "zod";
import { ConstraintSchema } from "@fairbuy/core";

export const WeightsSchema = z
  .object({
    cost: z.number().min(0),
    suitability: z.number().min(0),
    reliability: z.number().min(0),
  })
  .refine((w) => Math.abs(w.cost + w.suitability + w.reliability - 1) < 1e-9, { message: "Weights must sum to 1" });

export const CreateComparisonSchema = z.strictObject({
  category: z.string().min(1).max(50),
  // Bounded so a single request cannot make the engine do unbounded work.
  constraints: z.array(ConstraintSchema).max(50),
  weights: WeightsSchema.optional(),
});
export type CreateComparison = z.infer<typeof CreateComparisonSchema>;
