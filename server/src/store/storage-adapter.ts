/**
 * Storage adapter —— 把 server 现有的 SQLite store 适配成 core 的 `Storage` 契约。
 *
 * core 不认 SQLite，只认 `MemoryStorage` / `CharacterStateStorage` / `DiaryStorage`。
 * 现有的 `store/*` 模块的函数签名本来就符合这些接口，所以这里主要是包一层，
 * 让 core 与 server 之间有一道明确的接缝 —— 换存储实现时只改这一处。
 */

import type {
  CharacterStateStorage,
  ContentStorage,
  DiaryStorage,
  EventStorage,
  MemoryStorage,
  SnapshotStorage,
  Storage,
  WorldStateStorage,
} from "@worldx/core";
import * as charStateStore from "../store/character-state-store.js";
import * as memoryStore from "../store/memory-store.js";
import * as diaryStore from "../store/diary-store.js";
import * as worldStateStore from "../store/world-state-store.js";
import * as snapshotStore from "../store/snapshot-store.js";
import * as eventStore from "../store/event-store.js";
import * as contentStore from "../store/content-store.js";

export const sqliteMemoryStorage: MemoryStorage = {
  insertMemory: (memory) => memoryStore.insertMemory(memory),
  hasMemory: (characterId, type, content, gameDay, gameTick) =>
    memoryStore.hasMemory(characterId, type, content, gameDay, gameTick),
  getMemoriesByCharacter: (charId, options) =>
    memoryStore.getMemoriesByCharacter(charId, options),
  getMemory: (id) => memoryStore.getMemory(id),
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

export const sqliteWorldStateStorage: WorldStateStorage = {
  initWorldState: (locations, opts) => worldStateStore.initWorldState(locations, opts),
  getObjectState: (objectId) => worldStateStore.getObjectState(objectId),
  getAllObjectStates: () => worldStateStore.getAllObjectStates(),
  getObjectsByLocation: (locationId) => worldStateStore.getObjectsByLocation(locationId),
  updateObjectState: (objectId, patch) => worldStateStore.updateObjectState(objectId, patch),
  addUserToObject: (objectId, characterId) =>
    worldStateStore.addUserToObject(objectId, characterId),
  removeUserFromObject: (objectId, characterId) =>
    worldStateStore.removeUserFromObject(objectId, characterId),
  getGlobalState: (key) => worldStateStore.getGlobalState(key),
  setGlobalState: (key, value) => worldStateStore.setGlobalState(key, value),
  deleteGlobalState: (key) => worldStateStore.deleteGlobalState(key),
  getAllGlobalState: () => worldStateStore.getAllGlobalState(),
  getItemStock: (itemId) => worldStateStore.getItemStock(itemId),
  setItemStock: (itemId, stock, displayStates) =>
    worldStateStore.setItemStock(itemId, stock, displayStates),
  initItemStocks: (items) => worldStateStore.initItemStocks(items),
};

export const sqliteSnapshotStorage: SnapshotStorage = {
  createSnapshot: (gameTime, description) =>
    snapshotStore.createSnapshot(gameTime, description),
  restoreSnapshot: (snapshotId) => snapshotStore.restoreSnapshot(snapshotId),
  listSnapshots: () => snapshotStore.listSnapshots(),
};

export const sqliteEventStorage: EventStorage = {
  appendEvent: (event) => eventStore.appendEvent(event),
  appendEvents: (events) => eventStore.appendEvents(events),
  queryEvents: (filter) => eventStore.queryEvents(filter),
  getEventsByTimeRange: (from, to) => eventStore.getEventsByTimeRange(from, to),
  getEventsByIds: (ids) => eventStore.getEventsByIds(ids),
  getLatestEvents: (count) => eventStore.getLatestEvents(count),
  countEvents: (filter) => eventStore.countEvents(filter),
};

export const sqliteContentStorage: ContentStorage = {
  insertCandidate: (candidate) => contentStore.insertCandidate(candidate),
  getCandidates: (filter) => contentStore.getCandidates(filter),
  markReviewed: (id) => contentStore.markReviewed(id),
  deleteCandidate: (id) => contentStore.deleteCandidate(id),
};

/** server 用的默认存储实现（SQLite）。 */
export function createDefaultStorage(): Storage {
  return {
    memories: sqliteMemoryStorage,
    characterStates: sqliteCharacterStateStorage,
    diaries: sqliteDiaryStorage,
    worldState: sqliteWorldStateStorage,
    snapshots: sqliteSnapshotStorage,
    events: sqliteEventStorage,
    content: sqliteContentStorage,
  };
}
