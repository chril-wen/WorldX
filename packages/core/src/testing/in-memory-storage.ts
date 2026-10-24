/**
 * 内存版存储 —— 只用于 core 的单测。
 *
 * 有了 `MemoryStorage` 契约，core 的测试就不必拉起 SQLite：
 * 换数据库实现时，core 的用例一行都不用改。
 */

import type { MemoryEntry, MemoryStorage, MemoryQueryOptions } from "../contracts/index.js";

export class InMemoryMemoryStorage implements MemoryStorage {
  private rows: MemoryEntry[] = [];

  insertMemory(memory: MemoryEntry): void {
    this.rows.push({ ...memory });
  }

  hasMemory(
    characterId: string,
    type: string,
    content: string,
    gameDay: number,
    gameTick: number,
  ): boolean {
    return this.rows.some(
      (m) =>
        m.characterId === characterId &&
        m.type === type &&
        m.content === content &&
        m.gameDay === gameDay &&
        m.gameTick === gameTick,
    );
  }

  getMemoriesByCharacter(
    charId: string,
    options?: MemoryQueryOptions,
  ): MemoryEntry[] {
    let results = this.rows.filter((m) => m.characterId === charId);

    if (options?.isLongTerm !== undefined) {
      results = results.filter((m) => m.isLongTerm === options.isLongTerm);
    }
    if (options?.minImportance !== undefined) {
      results = results.filter((m) => m.importance >= options!.minImportance!);
    }
    if (options?.types && options.types.length > 0) {
      results = results.filter((m) => options!.types!.includes(m.type));
    }
    if (options?.tags && options.tags.length > 0) {
      results = results.filter((m) =>
        options!.tags!.some((t) => m.tags.includes(t)),
      );
    }

    // 与 SQLite 一致：按时间倒序（新的在前）。
    results = [...results].sort((a, b) =>
      b.gameDay - a.gameDay || b.gameTick - a.gameTick,
    );

    if (options?.limit !== undefined) {
      results = results.slice(0, options.limit);
    }

    return results.map((m) => ({ ...m }));
  }

  updateMemory(id: string, patch: Partial<MemoryEntry>): void {
    const row = this.rows.find((m) => m.id === id);
    if (!row) return;
    Object.assign(row, patch);
  }

  deleteMemory(id: string): void {
    this.rows = this.rows.filter((m) => m.id !== id);
  }

  /** 测试辅助：直接看当前存了多少条。 */
  get size(): number {
    return this.rows.length;
  }
}
