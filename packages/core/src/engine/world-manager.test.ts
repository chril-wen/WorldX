import { describe, it, expect, beforeEach } from "vitest";
import { WorldManager } from "./world-manager.js";
import { InMemoryWorldStateStorage } from "../testing/in-memory-world-state.js";
import { InMemorySnapshotStorage } from "../testing/in-memory-snapshots.js";
import { InMemoryEventStorage } from "../testing/in-memory-events.js";
import { InMemoryContentStorage } from "../testing/in-memory-content.js";
import type {
  Storage,
  WorldConfig,
  SceneConfig,
  CharacterProfile,
} from "../contracts/index.js";
import type { WorldConfigSource } from "../contracts/world-config.js";

/** 内存版配置源 —— core 的测试不该碰文件系统。 */
class FakeConfigSource implements WorldConfigSource {
  worldDir: string | null = null;
  worldConfig: WorldConfig;
  sceneConfig: SceneConfig;
  profiles: CharacterProfile[] = [];

  constructor(worldConfig: WorldConfig, sceneConfig: SceneConfig) {
    this.worldConfig = worldConfig;
    this.sceneConfig = sceneConfig;
  }

  getWorldDir(): string | null {
    return this.worldDir;
  }

  setWorldDir(dir: string): void {
    this.worldDir = dir;
  }

  loadWorldConfig(): WorldConfig {
    return this.worldConfig;
  }

  loadSceneConfig(): SceneConfig {
    return this.sceneConfig;
  }

  loadCharacterProfiles(): CharacterProfile[] {
    return this.profiles;
  }

  writeCharacterProfile(profile: CharacterProfile): void {
    this.profiles.push(profile);
  }

  invalidateCharacterProfileCache(): void {}

  reloadConfigs(): void {}
}

const sceneConfig: SceneConfig = {
  sceneType: "open",
  startTime: "09:00",
  tickDurationMinutes: 15,
  maxTicks: 48,
  displayFormat: "ancient_chinese",
  description: "测试用场景",
} as SceneConfig;

const worldConfig: WorldConfig = {
  worldName: "测试世界",
  worldDescription: "一个用于单测的小世界",
  locations: [
    {
      id: "main_area",
      name: "主区",
      description: "一个地方",
      objects: [
        {
          id: "table_1",
          locationId: "main_area",
          name: "桌子",
          defaultState: "idle",
          interactions: [],
        },
      ],
    },
  ],
  mainAreaPoints: [],
  worldActions: [],
};

function makeStorage(): Storage {
  return {
    memories: {} as Storage["memories"],
    characterStates: {} as Storage["characterStates"],
    diaries: {} as Storage["diaries"],
    worldState: new InMemoryWorldStateStorage(),
    snapshots: new InMemorySnapshotStorage(),
    events: new InMemoryEventStorage(),
    content: new InMemoryContentStorage(),
  };
}

let config: FakeConfigSource;
let storage: Storage;
let wm: WorldManager;

beforeEach(() => {
  config = new FakeConfigSource(worldConfig, sceneConfig);
  storage = makeStorage();
  wm = new WorldManager(config, storage);
  wm.initialize();
});

describe("WorldManager", () => {
  describe("initialize", () => {
    it("读进世界元信息", () => {
      expect(wm.getWorldName()).toBe("测试世界");
      expect(wm.getWorldDescription()).toBe("一个用于单测的小世界");
      expect(wm.getContentLanguage()).toBe("zh");
    });

    it("读进地点配置", () => {
      expect(wm.getLocations().map((l) => l.id)).toEqual(["main_area"]);
      expect(wm.getLocation("main_area")?.name).toBe("主区");
    });

    it("初始化世界状态：当天第 0 tick，天气晴", () => {
      expect(wm.getCurrentTime()).toEqual({ day: 1, tick: 0 });
      expect(storage.worldState.getGlobalState("weather")).toBe("clear");
    });

    it("场景配置读进来了", () => {
      expect(wm.getSceneConfig().sceneType).toBe("open");
    });
  });

  describe("advanceTick", () => {
    it("推进一 tick", () => {
      const r = wm.advanceTick();
      expect(r.previousTime).toEqual({ day: 1, tick: 0 });
      expect(r.currentTime).toEqual({ day: 1, tick: 1 });
      expect(r.didAdvanceDay).toBe(false);
      expect(wm.getCurrentTime()).toEqual({ day: 1, tick: 1 });
    });

    it("推进到底后翻到第二天", () => {
      // cycleTicks 是「一天有多少 tick」——推进到第 cycleTicks - 1 时翻页
      const cycle = wm.advanceTick().cycleTicks;
      for (let i = 1; i < cycle - 1; i++) wm.advanceTick();
      const last = wm.advanceTick();
      expect(last.didAdvanceDay).toBe(true);
      expect(last.currentTime).toEqual({ day: 2, tick: 0 });
    });
  });

  describe("setTime", () => {
    it("直接改时间", () => {
      wm.setTime({ day: 5, tick: 12 });
      expect(wm.getCurrentTime()).toEqual({ day: 5, tick: 12 });
    });
  });

  describe("物件状态", () => {
    it("能按地点列出物件", () => {
      const objs = wm.getLocationObjects("main_area");
      expect(objs.map((o) => o.id)).toEqual(["table_1"]);
    });

    it("能改物件状态", () => {
      wm.updateObjectState("table_1", "occupied", "有人在用");
      const state = storage.worldState.getObjectState("table_1");
      expect(state.state).toBe("occupied");
      expect(state.stateDescription).toBe("有人在用");
    });

    it("角色开始/停止使用物件", () => {
      expect(wm.characterStartUsingObject("table_1", "char_1")).toBe(true);
      expect(
        storage.worldState.getObjectState("table_1").currentUsers,
      ).toEqual(["char_1"]);
      wm.characterStopUsingObject("table_1", "char_1");
      expect(
        storage.worldState.getObjectState("table_1").currentUsers,
      ).toEqual([]);
    });
  });

  describe("全局状态", () => {
    it("能读写", () => {
      wm.setGlobal("custom_key", "custom_value");
      expect(wm.getGlobal("custom_key")).toBe("custom_value");
    });
  });

  describe("物品库存", () => {
    it("消费会扣库存", () => {
      wm.setGlobal("item:tea", JSON.stringify({ stock: 5, state: "available" }));
      expect(wm.consumeItem("tea", 2)).toBe(3);
      expect(wm.getGlobal("item:tea")).toContain('"stock":3');
    });

    it("库存不够时扣到 0，不为负", () => {
      wm.setGlobal("item:tea", JSON.stringify({ stock: 1, state: "available" }));
      expect(wm.consumeItem("tea", 5)).toBe(0);
      expect(wm.getGlobal("item:tea")).toContain('"stock":0');
    });

    it("没有这个物品时返回 null", () => {
      expect(wm.consumeItem("不存在的物品")).toBeNull();
    });
  });

  describe("快照", () => {
    it("能存能列", () => {
      const id = wm.createSnapshot("测试快照");
      const list = wm.listSnapshots();
      expect(list.map((s) => s.id)).toContain(id);
    });
  });

  describe("场景配置覆盖", () => {
    it("覆盖后生效", () => {
      wm.applySceneConfigOverride({ maxTicks: 20 });
      expect(wm.getSceneConfig().maxTicks).toBe(20);
    });
  });
});
