/**
 * 内存版角色状态存储 —— 只用于 core 的单测。
 *
 * 之前 core 的测试里，角色状态是用 `{} as Storage["characterStates"]`
 * 这种假对象糊过去的 —— 一旦要测「角色的状态真的被规则改动了」，
 * 就必须有个能真的存住状态的实现。
 *
 * 跟 `InMemoryMemoryStorage` 一个路子：core 的单测不拉 SQLite。
 */

import type { CharacterState, CharacterStateStorage } from "../contracts/index.js";

export class InMemoryCharacterStateStorage implements CharacterStateStorage {
  private rows: CharacterState[] = [];

  initCharacterState(state: CharacterState): void {
    // 同一个角色重复初始化 → 覆盖，不重复插
    const idx = this.rows.findIndex((r) => r.characterId === state.characterId);
    if (idx >= 0) {
      this.rows[idx] = { ...state };
      return;
    }
    this.rows.push({ ...state });
  }

  getCharacterState(id: string): CharacterState {
    const row = this.rows.find((r) => r.characterId === id);
    if (!row) throw new Error(`Character state not found: ${id}`);
    return { ...row };
  }

  getAllCharacterStates(): CharacterState[] {
    return this.rows.map((r) => ({ ...r }));
  }

  updateCharacterState(id: string, patch: Partial<CharacterState>): void {
    const row = this.rows.find((r) => r.characterId === id);
    if (!row) return;
    Object.assign(row, patch);
  }

  getCharactersByLocation(locationId: string): CharacterState[] {
    return this.rows
      .filter((r) => r.location === locationId)
      .map((r) => ({ ...r }));
  }

  /** 测试辅助：当前存了多少个角色。 */
  get size(): number {
    return this.rows.length;
  }
}
