/**
 * 存储契约 —— core 只认这些接口，不认 SQLite。
 *
 * 这样 core 可以脱离数据库单测（用内存实现），也允许将来换掉 SQLite。
 * server 侧的 `store/*` 作为 adapter 实现这些接口（见 server/src/core/storage-adapter.ts）。
 */

import type {
  CharacterState,
  DiaryEntry,
  GameTime,
  LocationConfig,
  MemoryEntry,
  MemoryType,
  ObjectRuntimeState,
  WorldGlobalEntry,
} from "./index.js";
import type { ContentStorage, EventStorage } from "./events.js";

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
  /** 取单条记忆；不存在时抛错。 */
  getMemory(id: string): MemoryEntry;
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

/** 物件运行时状态 + 世界全局状态 + 物品库存。 */
export interface WorldStateStorage {
  initWorldState(
    locations: LocationConfig[],
    opts?: { onlyMissingObjects?: boolean },
  ): void;
  getObjectState(objectId: string): ObjectRuntimeState;
  getAllObjectStates(): ObjectRuntimeState[];
  getObjectsByLocation(locationId: string): ObjectRuntimeState[];
  updateObjectState(objectId: string, patch: Partial<ObjectRuntimeState>): void;
  addUserToObject(objectId: string, characterId: string): void;
  removeUserFromObject(objectId: string, characterId: string): void;

  getGlobalState(key: string): string | null;
  setGlobalState(key: string, value: string): void;
  deleteGlobalState(key: string): void;
  getAllGlobalState(): WorldGlobalEntry[];

  getItemStock(itemId: string): ItemStock | null;
  setItemStock(
    itemId: string,
    stock: number,
    displayStates?: Record<string, number>,
  ): void;
  initItemStocks(
    items: Array<{
      id: string;
      initialStock: number;
      displayStates?: Record<string, number>;
    }>,
  ): void;
}

/** 物品库存快照。 */
export interface ItemStock {
  stock: number;
  state: string;
}

/** 快照的元信息。 */
export interface SnapshotMeta {
  id: string;
  gameDay: number;
  gameTick: number;
  description: string;
  filePath: string;
  createdAt: string;
}

/** 快照的读写能力。 */
export interface SnapshotStorage {
  createSnapshot(gameTime: GameTime, description?: string): string;
  restoreSnapshot(snapshotId: string): void;
  listSnapshots(): SnapshotMeta[];
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
  worldState: WorldStateStorage;
  snapshots: SnapshotStorage;
  events: EventStorage;
  content: ContentStorage;
}
