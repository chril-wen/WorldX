/**
 * Storage adapter —— 把 server 现有的 SQLite store 适配成 core 的 `Storage` 契约。
 *
 * core 不认 SQLite，只认 `MemoryStorage` / `CharacterStateStorage` / `DiaryStorage`。
 * 现有的 `store/*` 模块的函数签名本来就符合这些接口，所以这里主要是包一层，
 * 让 core 与 server 之间有一道明确的接缝 —— 换存储实现时只改这一处。
 */

import type {
  CharacterStateStorage,
  DiaryStorage,
  MemoryStorage,
  Storage,
} from "@worldx/core";
import * as charStateStore from "../store/character-state-store.js";
import * as memoryStore from "../store/memory-store.js";
import * as diaryStore from "../store/diary-store.js";

export const sqliteMemoryStorage: MemoryStorage = {
  insertMemory: (memory) => memoryStore.insertMemory(memory),
  hasMemory: (characterId, type, content, gameDay, gameTick) =>
    memoryStore.hasMemory(characterId, type, content, gameDay, gameTick),
  getMemoriesByCharacter: (charId, options) =>
    memoryStore.getMemoriesByCharacter(charId, options),
  updateMemory: (id, patch) => memoryStore.updateMemory(id, patch),
  deleteMemory: (id) => memoryStore.deleteMemory(id),
};

export const sqliteCharacterStateStorage: CharacterStateStorage = {
  initCharacterState: (state) => charStateStore.initCharacterState(state),
  getCharacterState: (id) => charStateStore.getCharacterState(id),
  getAllCharacterStates: () => charStateStore.getAllCharacterStates(),
  updateCharacterState: (id, patch) => charStateStore.updateCharacterState(id, patch),
  getCharactersByLocation: (locationId) =>
    charStateStore.getCharactersByLocation(locationId),
};

export const sqliteDiaryStorage: DiaryStorage = {
  addDiaryEntry: (entry) => diaryStore.addDiaryEntry(entry),
  getDiaryEntries: (charId, gameDay) => diaryStore.getDiaryEntries(charId, gameDay),
};

/** server 用的默认存储实现（SQLite）。 */
export function createDefaultStorage(): Storage {
  return {
    memories: sqliteMemoryStorage,
    characterStates: sqliteCharacterStateStorage,
    diaries: sqliteDiaryStorage,
  };
}
