import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildPerception } from "./perceiver.js";
import type { WorldManager } from "../core/world-manager.js";
import type { CharacterManager } from "../core/character-manager.js";
import type { GameTime } from "../types/index.js";

// eventStore 走 SQLite，perceiver 只需要它返回空数组 —— 用 mock 隔离，
// 让这个用例只测「感知装配」这一层逻辑。
vi.mock("../store/event-store.js", () => ({
  queryEvents: () => [],
}));

vi.mock("../core/weather-manager.js", () => ({
  getWeatherState: () => ({ kind: "clear", sinceAbsTick: 0 }),
  describeWeatherFor: () => "晴",
  resolveExposure: () => "outdoor",
}));

const gameTime: GameTime = { day: 1, tick: 10 };

function makeWorldManager(overrides: Partial<WorldManager> = {}): WorldManager {
  return {
    getLocation: () => ({
      id: "main_area",
      name: "茶馆",
      description: "一间热闹的茶馆",
    }),
    getLocationObjects: () => [],
    getAvailableInteractions: () => [],
    getAvailableMainAreaZones: () => [],
    getMainAreaPointZone: () => undefined,
    getSceneConfig: () => ({ tickDurationMinutes: 30 }),
    ...overrides,
  } as unknown as WorldManager;
}

function makeCharacterManager(
  states: any[],
  profiles: Record<string, any> = {},
): CharacterManager {
  const profileOf = (id: string) =>
    profiles[id] ?? { id, name: `角色${id}`, appearanceHint: undefined };
  return {
    getState: (id: string) => states.find((s) => s.characterId === id),
    getProfile: profileOf,
    // 真实实现返回扁平的 CharacterState[]
    getAllStates: () => states,
    // 真实实现返回 { profile, state } 配对数组
    getCharactersAtLocation: (loc: string) =>
      states
        .filter((s) => s.location === loc)
        .map((s) => ({ profile: profileOf(s.characterId), state: s })),
  } as unknown as CharacterManager;
}

function makeState(id: string, overrides: Partial<any> = {}) {
  return {
    characterId: id,
    location: "main_area",
    mainAreaPointId: null,
    currentAction: null,
    currentActionTarget: null,
    actionStartTick: 0,
    actionEndTick: 0,
    emotionValence: 0,
    emotionArousal: 0,
    curiosity: 50,
    dailyPlan: null,
    ...overrides,
  };
}

describe("buildPerception", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("位置不存在时返回最小感知而不是抛错", () => {
    const wm = makeWorldManager({ getLocation: () => undefined });
    const cm = makeCharacterManager([makeState("c1")]);
    const p = buildPerception("c1", wm, cm, gameTime);
    expect(p.currentLocation).toBe("main_area");
    expect(p.locationDescription).toBe("");
    expect(p.objectsHere).toEqual([]);
    expect(p.charactersHere).toEqual([]);
  });

  it("返回地点名称与描述", () => {
    const wm = makeWorldManager();
    const cm = makeCharacterManager([makeState("c1")]);
    const p = buildPerception("c1", wm, cm, gameTime);
    expect(p.currentLocation).toBe("茶馆");
    expect(p.locationDescription).toBe("一间热闹的茶馆");
  });

  it("把自己从 charactersHere 里排除", () => {
    const wm = makeWorldManager();
    const cm = makeCharacterManager([
      makeState("c1"),
      makeState("c2", { emotionValence: 3, emotionArousal: 8 }),
    ]);
    const p = buildPerception("c1", wm, cm, gameTime);
    expect(p.charactersHere.map((c) => c.id)).toEqual(["c2"]);
  });

  it("情绪不外露时不带 emotionLabel", () => {
    const wm = makeWorldManager();
    const cm = makeCharacterManager([
      makeState("c1"),
      makeState("c2", { emotionValence: 1, emotionArousal: 3 }),
    ]);
    const p = buildPerception("c1", wm, cm, gameTime);
    expect(p.charactersHere[0].emotionLabel).toBeUndefined();
  });

  it("效价绝对值 >= 2 时情绪外露", () => {
    const wm = makeWorldManager();
    const cm = makeCharacterManager([
      makeState("c1"),
      makeState("c2", { emotionValence: 2, emotionArousal: 1 }),
    ]);
    const p = buildPerception("c1", wm, cm, gameTime);
    expect(p.charactersHere[0].emotionLabel).toBe("安宁");
  });

  it("效价绝对值 < 2 但唤醒 >= 7 时情绪外露", () => {
    const wm = makeWorldManager();
    const cm = makeCharacterManager([
      makeState("c1"),
      makeState("c2", { emotionValence: 1, emotionArousal: 7 }),
    ]);
    const p = buildPerception("c1", wm, cm, gameTime);
    expect(p.charactersHere[0].emotionLabel).toBe("紧张");
  });

  it("物体的可用互动被展开成名称数组", () => {
    const wm = makeWorldManager({
      getLocationObjects: () => [
        {
          id: "obj_tea",
          name: "茶壶",
          state: "full",
          stateDescription: "满的",
          locationId: "main_area",
          defaultState: "full",
          capacity: 1,
          interactions: [],
          objectId: "obj_tea",
          currentUsers: [],
        },
      ],
      getAvailableInteractions: () => [
        {
          id: "act_pour",
          name: "倒茶",
          availableWhenState: ["full"],
          duration: 5,
          effects: [],
        },
        {
          id: "act_smell",
          name: "闻香",
          availableWhenState: ["full"],
          duration: 3,
          effects: [],
        },
      ],
    });
    const cm = makeCharacterManager([makeState("c1")]);
    const p = buildPerception("c1", wm, cm, gameTime);
    expect(p.objectsHere).toHaveLength(1);
    expect(p.objectsHere[0].name).toBe("茶壶");
    expect(p.objectsHere[0].availableInteractions).toEqual(["倒茶", "闻香"]);
  });

  it("在主区域时所有角色都在场（不看他们实际在哪个地点）", () => {
    const wm = makeWorldManager();
    const cm = makeCharacterManager([
      makeState("c1"),
      makeState("c2", { location: "main_area" }),
      makeState("c3", { location: "其他地点" }),
    ]);
    const p = buildPerception("c1", wm, cm, gameTime);
    // 既有行为：state.location === "main_area" 时走 getAllStates()，
    // 不按各角色实际 location 过滤。这里锁住现状，不做行为改动。
    expect(p.charactersHere.map((c) => c.id)).toEqual(["c2", "c3"]);
  });

  it("不在主区域时只算同地点的角色", () => {
    const wm = makeWorldManager();
    const cm = makeCharacterManager([
      makeState("c1", { location: "巷口" }),
      makeState("c2", { location: "巷口" }),
      makeState("c3", { location: "main_area" }),
    ]);
    const p = buildPerception("c1", wm, cm, gameTime);
    expect(p.charactersHere.map((c) => c.id)).toEqual(["c2"]);
  });

  it("感知包含天气描述", () => {
    const wm = makeWorldManager();
    const cm = makeCharacterManager([makeState("c1")]);
    const p = buildPerception("c1", wm, cm, gameTime);
    expect(p.weather).toBe("晴");
  });
});
