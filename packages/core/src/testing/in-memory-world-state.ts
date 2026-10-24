/**
 * 内存版世界状态存储 —— 只用于 core 的单测。
 *
 * 有了 `WorldStateStorage` 契约，core 的测试就不必拉起 SQLite：
 * 换数据库实现时，core 的用例一行都不用改。
 */

import type {
  ItemStock,
  LocationConfig,
  ObjectRuntimeState,
  WorldGlobalEntry,
  WorldStateStorage,
} from "../contracts/index.js";

export class InMemoryWorldStateStorage implements WorldStateStorage {
  private objects = new Map<string, ObjectRuntimeState>();
  private globals = new Map<string, string>();

  initWorldState(
    locations: LocationConfig[],
    opts: { onlyMissingObjects?: boolean } = {},
  ): void {
    for (const loc of locations) {
      for (const obj of loc.objects) {
        if (opts.onlyMissingObjects && this.objects.has(obj.id)) continue;
        if (this.objects.has(obj.id)) continue;
        this.objects.set(obj.id, {
          objectId: obj.id,
          locationId: obj.locationId,
          state: obj.defaultState,
          stateDescription: "",
          currentUsers: [],
        });
      }
    }
    if (opts.onlyMissingObjects) return;
    this.globals.set("current_day", "1");
    this.globals.set("current_tick", "0");
    this.globals.set("power", "on");
    this.globals.set("weather", "clear");
  }

  getObjectState(objectId: string): ObjectRuntimeState {
    const row = this.objects.get(objectId);
    if (!row) throw new Error(`Object not found: ${objectId}`);
    return { ...row, currentUsers: [...row.currentUsers] };
  }

  getAllObjectStates(): ObjectRuntimeState[] {
    return [...this.objects.values()].map((o) => ({
      ...o,
      currentUsers: [...o.currentUsers],
    }));
  }

  getObjectsByLocation(locationId: string): ObjectRuntimeState[] {
    return this.getAllObjectStates().filter((o) => o.locationId === locationId);
  }

  updateObjectState(
    objectId: string,
    patch: Partial<ObjectRuntimeState>,
  ): void {
    const row = this.objects.get(objectId);
    if (!row) return;
    Object.assign(row, patch);
  }

  addUserToObject(objectId: string, characterId: string): void {
    const state = this.getObjectState(objectId);
    if (state.currentUsers.includes(characterId)) return;
    state.currentUsers.push(characterId);
    this.updateObjectState(objectId, { currentUsers: state.currentUsers });
  }

  removeUserFromObject(objectId: string, characterId: string): void {
    const state = this.getObjectState(objectId);
    const idx = state.currentUsers.indexOf(characterId);
    if (idx < 0) return;
    state.currentUsers.splice(idx, 1);
    this.updateObjectState(objectId, { currentUsers: state.currentUsers });
  }

  getGlobalState(key: string): string | null {
    return this.globals.get(key) ?? null;
  }

  setGlobalState(key: string, value: string): void {
    this.globals.set(key, value);
  }

  deleteGlobalState(key: string): void {
    this.globals.delete(key);
  }

  getAllGlobalState(): WorldGlobalEntry[] {
    return [...this.globals.entries()].map(([key, value]) => ({ key, value }));
  }

  getItemStock(itemId: string): ItemStock | null {
    const raw = this.getGlobalState(`item:${itemId}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ItemStock;
    } catch {
      return null;
    }
  }

  setItemStock(
    itemId: string,
    stock: number,
    displayStates?: Record<string, number>,
  ): void {
    let state = "available";
    if (displayStates) {
      const thresholds = Object.entries(displayStates)
        .map(([s, threshold]) => ({ state: s, threshold: Number(threshold) }))
        .sort((a, b) => b.threshold - a.threshold);
      for (const { state: s, threshold } of thresholds) {
        if (stock >= threshold) {
          state = s;
          break;
        }
      }
    }
    this.setGlobalState(
      `item:${itemId}`,
      JSON.stringify({ stock: Math.max(0, stock), state }),
    );
  }

  initItemStocks(
    items: Array<{
      id: string;
      initialStock: number;
      displayStates?: Record<string, number>;
    }>,
  ): void {
    for (const item of items) {
      this.setItemStock(item.id, item.initialStock, item.displayStates);
    }
  }
}
