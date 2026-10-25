import { describe, it, expect, beforeEach } from "vitest";
import { WorldManager } from "./world-manager.js";
import { CharacterManager } from "./character-manager.js";
import { InMemoryMemoryStorage } from "../testing/in-memory-storage.js";
import { InMemoryCharacterStateStorage } from "../testing/in-memory-character-states.js";
import { InMemoryWorldStateStorage } from "../testing/in-memory-world-state.js";
import { InMemorySnapshotStorage } from "../testing/in-memory-snapshots.js";
import { InMemoryEventStorage } from "../testing/in-memory-events.js";
import { InMemoryContentStorage } from "../testing/in-memory-content.js";
import { DEFAULT_RULES, mergeRules } from "./rules.js";
import type { WorldConfigSource } from "../contracts/world-config.js";
import type { Storage } from "../contracts/storage.js";
import type { WorldConfig, CharacterProfile, SceneConfig } from "../contracts/index.js";

/**
 * 规则接入测试 —— 验证规则**真的接上了运行时**。
 *
 * 规则层的单元测试证明「规则本身算得对」，
 * 这里证明「world.json 里的 rules 真的被引擎读到了并用上了」。
 *
 * 走的是真实链路：world.json → WorldConfigSource → WorldManager → CharacterManager。
 */

function makeConfigSource(
  worldConfig: Partial<WorldConfig>,
  profiles: Partial<CharacterProfile>[] = [],
): WorldConfigSource {
  const full: WorldConfig = {
    worldName: "测试世界",
    locations: [
      {
        id: "main_area",
        name: "主区域",
        description: "测试",
        objects: [],
        adjacentLocations: [],
      },
    ],
    ...worldConfig,
  } as WorldConfig;

  const normalized: CharacterProfile[] = profiles.map((p) => ({
    id: p.id ?? "char_1",
    name: p.name ?? "测试角色",
    role: "NPC",
    nickname: "测",
    startPosition: "main_area",
    coreMotivation: "动机",
    coreValues: [],
    speakingStyle: "普通",
    fears: [],
    preferredLocations: [],
    preferredActivities: [],
    socialStyle: "introvert",
    extraversionLevel: 0,
    intuitionLevel: 0,
    skills: [],
    writeDiary: false,
    fourthWallCandidate: false,
    tags: [],
    initialMemories: [],
    ...p,
  })) as CharacterProfile[];

  const scene: SceneConfig = {
    sceneType: "open",
    startTime: "08:00",
    tickDurationMinutes: 15,
    maxTicks: 20,
    displayFormat: "modern",
    description: "",
    multiDay: {
      enabled: true,
      endOfDayText: "",
      newDayText: "",
      nextDayStartTime: "08:00",
    },
  };

  return {
    getWorldDir: () => null,
    setWorldDir: () => {},
    loadWorldConfig: () => full,
    loadSceneConfig: () => scene,
    loadCharacterProfiles: () => normalized,
    writeCharacterProfile: () => {},
    invalidateCharacterProfileCache: () => {},
    reloadConfigs: () => {},
  };
}

describe("世界规则接入运行时", () => {
  let storage: Storage;

  beforeEach(() => {
    storage = {
      memories: new InMemoryMemoryStorage(),
      characterStates: new InMemoryCharacterStateStorage(),
      diaries: { addDiaryEntry: () => {}, getDiaryEntries: () => [] },
      worldState: new InMemoryWorldStateStorage(),
      snapshots: new InMemorySnapshotStorage(),
      events: new InMemoryEventStorage(),
      content: new InMemoryContentStorage(),
    };
  });

  it("world.json 没有 rules 段时用默认值", () => {
    const wm = new WorldManager(makeConfigSource({}), storage);
    wm.initialize();
    expect(wm.getRules()).toEqual(DEFAULT_RULES);
  });

  it("world.json 的 rules 段被读进来了", () => {
    const wm = new WorldManager(
      makeConfigSource({ rules: { emotion: { decayRate: 0.5 } } }),
      storage,
    );
    wm.initialize();
    expect(wm.getRules().emotion.decayRate).toBe(0.5);
    // 没写的项仍是默认值
    expect(wm.getRules().emotion.valenceCurrentWeight).toBe(0.7);
    expect(wm.getRules().memory.recencyDecayRate).toBe(0.05);
  });

  it("reload 后规则跟着重载（外部改过 world.json 也认）", () => {
    let current: WorldConfig;
    const source = makeConfigSource({});
    const wrapped: WorldConfigSource = {
      ...source,
      loadWorldConfig: () => current,
    };
    current = {
      ...source.loadWorldConfig(),
      rules: { emotion: { decayRate: 0.9 } },
    };

    const wm = new WorldManager(wrapped, storage);
    wm.initialize();
    expect(wm.getRules().emotion.decayRate).toBe(0.9);

    // 外部把规则改了
    current = {
      ...current,
      rules: { emotion: { decayRate: 0.3 } },
    };
    wm.reloadLocations();
    expect(wm.getRules().emotion.decayRate).toBe(0.3);
  });

  it("角色级 override 生效：只覆盖写了的那一项", () => {
    const source = makeConfigSource(
      { rules: { emotion: { decayRate: 0.9 } } },
      [{ id: "char_1", rules: { memory: { recencyDecayRate: 0.5 } } }],
    );
    const wm = new WorldManager(source, storage);
    wm.initialize();

    // 角色配置必须来自**同一个** config source —— 否则角色根本没有加载进来
    const cm = new CharacterManager(wm, storage, source);
    cm.initialize();

    const rules = cm.getRulesFor("char_1");
    // 角色覆盖了记忆衰减
    expect(rules.memory.recencyDecayRate).toBe(0.5);
    // 世界级的情绪衰减，角色没写 → 继承
    expect(rules.emotion.decayRate).toBe(0.9);
  });

  it("没有 override 的角色拿到的就是世界级规则", () => {
    const source = makeConfigSource(
      { rules: { emotion: { decayRate: 0.9 } } },
      [{ id: "char_1" }, { id: "char_2" }],
    );
    const wm = new WorldManager(source, storage);
    wm.initialize();
    const cm = new CharacterManager(wm, storage, source);
    cm.initialize();

    expect(cm.getRulesFor("char_1").emotion.decayRate).toBe(0.9);
    expect(cm.getRulesFor("char_2").emotion.decayRate).toBe(0.9);
  });

  it("tickPassiveUpdate 用的是生效的规则（世界级）", () => {
    const source = makeConfigSource(
      {
        rules: { needs: { baseDecay: 2 } },
      },
      [{ id: "char_1" }],
    );
    const wm = new WorldManager(source, storage);
    wm.initialize();
    const cm = new CharacterManager(wm, storage, source);
    cm.initialize();

    const before = cm.getState("char_1").curiosity;
    cm.tickPassiveUpdate("char_1", { day: 1, tick: 0 });
    const after = cm.getState("char_1").curiosity;

    // baseDecay=2 → 好奇掉 2（默认是掉 0.5）
    expect(before - after).toBeCloseTo(2, 6);
  });

  it("tickPassiveUpdate 用的是角色级 override", () => {
    const source = makeConfigSource(
      { rules: { needs: { baseDecay: 2 } } },
      [{ id: "char_1", rules: { needs: { baseDecay: 0.25 } } }],
    );
    const wm = new WorldManager(source, storage);
    wm.initialize();
    const cm = new CharacterManager(wm, storage, source);
    cm.initialize();

    const before = cm.getState("char_1").curiosity;
    cm.tickPassiveUpdate("char_1", { day: 1, tick: 0 });
    const after = cm.getState("char_1").curiosity;

    // 角色 override 盖过世界级 → 掉 0.25
    expect(before - after).toBeCloseTo(0.25, 6);
  });

  it("记忆规则按角色解析 —— 角色 override 影响检索", () => {
    const source = makeConfigSource(
      { rules: { memory: { recencyDecayRate: 0.05 } } },
      [{ id: "char_1", rules: { memory: { recencyDecayRate: 10 } } }],
    );
    const wm = new WorldManager(source, storage);
    wm.initialize();
    const cm = new CharacterManager(wm, storage, source);
    cm.initialize();

    // 角色的记忆规则生效
    expect(cm.memoryManager.getRulesFor("char_1").recencyDecayRate).toBe(10);
    // 没覆盖的项仍是世界级
    expect(cm.memoryManager.getRulesFor("char_1").relevanceWeight).toBe(3);
  });

  it("resolveRulesForCharacter 接受部分规则", () => {
    const wm = new WorldManager(makeConfigSource({}), storage);
    wm.initialize();

    const resolved = wm.resolveRulesForCharacter({
      emotion: { decayRate: 0.1 },
    });
    expect(resolved.emotion.decayRate).toBe(0.1);
    expect(resolved.emotion.strongArousalThreshold).toBe(6);
  });

  it("resolveRulesForCharacter(undefined) 返回世界级规则本身", () => {
    const wm = new WorldManager(makeConfigSource({}), storage);
    wm.initialize();
    expect(wm.resolveRulesForCharacter(undefined)).toBe(wm.getRules());
  });

  it("规则写错不会让引擎崩掉（合并时兜底）", () => {
    const wm = new WorldManager(
      makeConfigSource({
        rules: {
          emotion: { decayRate: "很快", 拼错的键: 1 },
          不存在的组: { x: 1 },
          memory: { recencyDecayRate: "x" },
        },
      }),
      storage,
    );
    expect(() => wm.initialize()).not.toThrow();
    expect(wm.getRules().emotion.decayRate).toBe(0.95);
    expect(wm.getRules().memory.recencyDecayRate).toBe(0.05);
  });

  it("reloadProfiles 之后角色级规则跟着更新（改完不用重启 server）", () => {
    let charRules: unknown = undefined;
    const source = makeConfigSource(
      { rules: { emotion: { decayRate: 0.9 } } },
      [{ id: "char_1" }],
    );
    const baseProfiles = source.loadCharacterProfiles();
    const wrapped: WorldConfigSource = {
      ...source,
      loadCharacterProfiles: () =>
        baseProfiles.map((p) => ({ ...p, rules: charRules })),
    };
    const wm = new WorldManager(wrapped, storage);
    wm.initialize();
    const cm = new CharacterManager(wm, storage, wrapped);
    cm.initialize();

    // 一开始没有角色级 override
    expect(cm.getRulesFor("char_1").memory.recencyDecayRate).toBe(0.05);

    // 外部改了角色的 rules 段
    charRules = { memory: { recencyDecayRate: 0.9 } };
    cm.reloadProfiles();

    // 重载之后生效了
    expect(cm.getRulesFor("char_1").memory.recencyDecayRate).toBe(0.9);
    // 没被覆盖的项仍是世界级
    expect(cm.getRulesFor("char_1").emotion.decayRate).toBe(0.9);
  });

  it("检索权重跟着规则走 —— 改 relevanceWeight 立刻生效（不用重启）", () => {
    // 权重之前是构造时抄一份的，改了 world.json 也不生效。
    // 规则既然是数据，权重就该跟着数据走。
    const source = makeConfigSource(
      { rules: { memory: { relevanceWeight: 10 } } },
      [{ id: "char_1" }],
    );
    const wm = new WorldManager(source, storage);
    wm.initialize();
    const cm = new CharacterManager(wm, storage, source);
    cm.initialize();

    // 加一条记忆，重要度 0、情感 0 —— 分数只可能来自相关度权重
    cm.memoryManager.addMemory({
      characterId: "char_1",
      type: "observation",
      content: "无关的事",
      gameTime: { day: 1, tick: 0 },
      importance: 0,
      emotionalValence: 0,
      emotionalIntensity: 0,
    });

    const rules = cm.memoryManager.getRulesFor("char_1");
    expect(rules.relevanceWeight).toBe(10);
  });
});

describe("mergeRules 的角色级用法", () => {
  it("角色级只覆盖它写了的组", () => {
    const world = mergeRules({
      emotion: { decayRate: 0.9, strongArousalThreshold: 8 },
    });
    const char = mergeRules({ emotion: { decayRate: 0.5 } }, world);

    expect(char.emotion.decayRate).toBe(0.5);
    // 同组的其他项继承世界级
    expect(char.emotion.strongArousalThreshold).toBe(8);
  });

  it("角色级可以覆盖世界级没写的组", () => {
    const world = mergeRules({ emotion: { decayRate: 0.9 } });
    const char = mergeRules({ memory: { recencyDecayRate: 0.5 } }, world);

    expect(char.memory.recencyDecayRate).toBe(0.5);
    expect(char.memory.relevanceWeight).toBe(3);
    expect(char.emotion.decayRate).toBe(0.9);
  });
});
