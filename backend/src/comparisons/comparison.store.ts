import { Injectable } from "@nestjs/common";
import type { ComparisonResult } from "@fairbuy/core";
import type { CreateComparison } from "./comparison.schema.js";

export interface StoredComparison {
  id: string;
  createdAt: string;
  connector: string;
  request: CreateComparison;
  result: ComparisonResult;
}

// In-memory store until Supabase lands. Bounded: the oldest entries are evicted first.
@Injectable()
export class ComparisonStore {
  static readonly MAX_ENTRIES = 500;
  private readonly entries = new Map<string, StoredComparison>();

  save(comparison: StoredComparison): void {
    this.entries.set(comparison.id, comparison);
    while (this.entries.size > ComparisonStore.MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value!;
      this.entries.delete(oldest);
    }
  }

  get(id: string): StoredComparison | undefined {
    return this.entries.get(id);
  }
}
