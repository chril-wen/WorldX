/**
 * 内存版内容候选存储 —— 只用于 core 的单测。
 */

import type {
  CandidateFilter,
  ContentCandidate,
  ContentStorage,
} from "../contracts/index.js";

export class InMemoryContentStorage implements ContentStorage {
  private rows: ContentCandidate[] = [];

  insertCandidate(candidate: ContentCandidate): void {
    this.rows.push({ ...candidate });
  }

  getCandidates(filter: CandidateFilter = {}): ContentCandidate[] {
    let results = this.rows.filter((c) => {
      if (filter.type !== undefined && c.type !== filter.type) return false;
      if (filter.reviewed !== undefined && c.reviewed !== filter.reviewed) {
        return false;
      }
      if (
        filter.minDramScore !== undefined &&
        c.dramScore < filter.minDramScore
      ) {
        return false;
      }
      return true;
    });

    if (filter.limit !== undefined) results = results.slice(0, filter.limit);
    return results.map((c) => ({ ...c }));
  }

  markReviewed(id: string): void {
    const row = this.rows.find((c) => c.id === id);
    if (row) row.reviewed = true;
  }

  deleteCandidate(id: string): void {
    this.rows = this.rows.filter((c) => c.id !== id);
  }
}
