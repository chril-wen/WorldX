/**
 * 存储契约 —— core 只认这些接口，不认 SQLite。
 *
 * 这样 core 可以脱离数据库单测（用内存实现），也允许将来换掉 SQLite。
 * server 侧的 `store/*` 作为 adapter 实现这些接口（见 server/src/core/storage-adapter.ts）。
 */

import type { CharacterState, DiaryEntry, MemoryEntry, MemoryType } from "./index.js";

export interface MemoryQueryOptions {
  limit?: number;
  isLongTerm?: boolean;
  minImportance?: number;
  types?: MemoryType[];
  tags?: string[];
}

/** 记忆的读写能力。 */
export interface MemoryStorage {
  insertMemory(memory: MemoryEntry): void;
  hasMemory(
    characterId: string,
    type: MemoryType,
    content: string,
    gameDay: number,
    gameTick: number,
  ): boolean;
  getMemoriesByCharacter(
    charId: string,
    options?: MemoryQueryOptions,
  ): MemoryEntry[];
  updateMemory(id: string, patch: Partial<MemoryEntry>): void;
  deleteMemory(id: string): void;
}

/** 角色运行时状态的读写能力。 */
export interface CharacterStateStorage {
  initCharacterState(state: CharacterState): void;
  getCharacterState(id: string): CharacterState;
  getAllCharacterStates(): CharacterState[];
  updateCharacterState(id: string, patch: Partial<CharacterState>): void;
  getCharactersByLocation(locationId: string): CharacterState[];
}

/** 日记的读写能力。 */
export interface DiaryStorage {
  addDiaryEntry(entry: DiaryEntry): void;
  getDiaryEntries(charId: string, gameDay?: number): DiaryEntry[];
}

/**
 * core 需要的全部存储能力。
 *
 * 注意这个接口是**按能力**划分的，不是按表划分的 —— core 只声明它真正用到的方法，
 * server 的 adapter 可以直接把现有的 `store/*` 模块塞进来。
 */
export interface Storage {
  memories: MemoryStorage;
  characterStates: CharacterStateStorage;
  diaries: DiaryStorage;
}
