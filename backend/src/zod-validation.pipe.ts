import { BadRequestException, type PipeTransform } from "@nestjs/common";
import type { ZodType } from "zod";

// Validates request bodies with the shared Zod schemas, so the API accepts exactly
// what the contract in @fairbuy/core describes.
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid request body.",
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    return parsed.data;
  }
}
