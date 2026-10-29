import { Body, Controller, Get, HttpCode, Inject, NotFoundException, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { ZodValidationPipe } from "../zod-validation.pipe.js";
import { CreateComparisonSchema, type CreateComparison } from "./comparison.schema.js";
import type { StoredComparison } from "./comparison.store.js";
import { ComparisonsService } from "./comparisons.service.js";

@Controller("v1/comparisons")
export class ComparisonsController {
  constructor(@Inject(ComparisonsService) private readonly comparisons: ComparisonsService) {}

  @Post()
  @HttpCode(201)
  create(@Body(new ZodValidationPipe(CreateComparisonSchema)) body: CreateComparison): Promise<StoredComparison> {
    return this.comparisons.create(body);
  }

  @Get(":id")
  get(@Param("id", new ParseUUIDPipe({ version: "4" })) id: string): StoredComparison {
    const comparison = this.comparisons.get(id);
    if (!comparison) throw new NotFoundException("Comparison not found.");
    return comparison;
  }
}
