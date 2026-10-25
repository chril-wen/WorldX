import { describe, it, expect } from "vitest";
import { migrateWorldConfig } from "./world-migration.js";
import {
  DEFAULT_CENTER_LOCATION_ID,
  WORLD_SCHEMA_VERSION,
} from "../contracts/world.js";

/**
 * world.json 迁移 —— 旧世界自动升级，且**不改行为**。
 *
 * ## 这个测试要证明三件事
 *
 * 1. **旧世界读进来就能跑** —— 不需要用户手动改磁盘文件
 * 2. **迁移是幂等的** —— 迁移过的再迁移，输出不变
 *    （`addLocation()` 会把内存态写回磁盘，写回的东西必须已经迁移过）
 * 3. **迁移不丢数据** —— 除新增字段外逐字段相等
 *
 * 真实世界的 world.json 键位本来就不齐
 * （`economics` / `hearsay` / `weather` 有的有、有的没有），
 * 所以「残缺输入」是常态，不是异常。
 */

describe("world.json 迁移 —— v1 → v2", () => {
  it("没有 schemaVersion 的旧世界会被补上版本号", () => {
    const migrated = migrateWorldConfig({
      worldName: "旧世界",
      locations: [{ id: "main_area", name: "主区域", description: "", adjacentLocations: [], objects: [] }],
    });
    expect(migrated.schemaVersion).toBe(WORLD_SCHEMA_VERSION);
  });

  it("没有 centerLocationId 的旧世界会被补上默认中心 id", () => {
    const migrated = migrateWorldConfig({ worldName: "旧世界", locations: [] });
    expect(migrated.centerLocationId).toBe(DEFAULT_CENTER_LOCATION_ID);
    expect(migrated.centerLocationId).toBe("main_area");
  });

  it("迁移后默认路径的行为跟改造前一致", () => {
    // 旧世界迁移出来的中心 id 就是 "main_area" ——
    // 所以所有 `location === "main_area"` 的判断结果不变。
    const migrated = migrateWorldConfig({
      worldName: "旧世界",
      locations: [{ id: "main_area", name: "主区域", description: "", adjacentLocations: [], objects: [] }],
    });
    expect(migrated.locations.some((l) => l.id === migrated.centerLocationId)).toBe(true);
  });

  it("显式写了 centerLocationId 的世界保留自己的值", () => {
    const migrated = migrateWorldConfig({
      worldName: "新世界",
      centerLocationId: "town_square",
      locations: [{ id: "town_square", name: "广场", description: "", adjacentLocations: [], objects: [] }],
    });
    expect(migrated.centerLocationId).toBe("town_square");
  });
});

describe("迁移 —— 幂等", () => {
  it("迁移两次的输出完全一样", () => {
    const raw = {
      worldName: "旧世界",
      locations: [{ id: "main_area", name: "主区域", description: "", adjacentLocations: [], objects: [] }],
      rules: { emotion: { decayRate: 0.9 } },
    };
    const once = migrateWorldConfig(raw);
    const twice = migrateWorldConfig(once);
    expect(twice).toEqual(once);
  });

  it("已经是 v2 的配置不被改动（除了补齐缺失的默认字段）", () => {
    const raw = {
      schemaVersion: WORLD_SCHEMA_VERSION,
      centerLocationId: "town_square",
      worldName: "新世界",
      locations: [{ id: "town_square", name: "广场", description: "", adjacentLocations: [], objects: [] }],
    };
    expect(migrateWorldConfig(raw)).toEqual(raw);
  });

  it("版本号高于当前时也不崩（未来的世界文件）", () => {
    const raw = { schemaVersion: 99, worldName: "未来的世界", locations: [] };
    const migrated = migrateWorldConfig(raw);
    expect(migrated.schemaVersion).toBe(99);
    expect(migrated.centerLocationId).toBe("main_area");
  });
});

describe("迁移 —— 不丢数据", () => {
  it("除新增的两个字段外，原有内容逐字段不变", () => {
    const raw = {
      worldName: "测试世界",
      worldDescription: "描述",
      worldSocialContext: "社交背景",
      contentLanguage: "zh",
      originalPrompt: "原始提示词",
      locations: [{ id: "main_area", name: "主区域", description: "d", adjacentLocations: ["a"], objects: [] }],
      mainAreaPoints: [{ id: "main_area_point_1", name: "点位1", x: 1, y: 2, adjacentPointIds: [] }],
      worldSize: { width: 10, height: 10 },
      economics: { items: [] },
      weather: { preset: "clear" },
      hearsay: { enabled: true },
      rules: { emotion: { decayRate: 0.9 } },
      metadata: { worldName: "测试世界" },
    };
    const migrated = migrateWorldConfig(raw) as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      expect(migrated[key]).toEqual((raw as Record<string, unknown>)[key]);
    }
  });

  it("自定义的顶层字段也不丢（插件可能加的）", () => {
    const migrated = migrateWorldConfig({
      worldName: "w",
      locations: [],
      myPluginField: { anything: true },
    }) as Record<string, unknown>;
    expect(migrated.myPluginField).toEqual({ anything: true });
  });
});

describe("迁移 —— 容忍残缺输入", () => {
  it("null / 数组 / 字符串都能处理", () => {
    for (const input of [null, [], "nope", 42, undefined]) {
      const migrated = migrateWorldConfig(input);
      expect(migrated.schemaVersion).toBe(WORLD_SCHEMA_VERSION);
      expect(migrated.centerLocationId).toBe("main_area");
      expect(migrated.locations).toEqual([]);
    }
  });

  it("缺 locations 时补空数组", () => {
    const migrated = migrateWorldConfig({ worldName: "w" });
    expect(migrated.locations).toEqual([]);
  });

  it("centerLocationId 是空串 / 空白时用默认值", () => {
    // 空串会让 `location === centerId` 永远为 false ——
    // 角色在主区域里却被当成在别的地方。这必须兜住。
    for (const bad of ["", "   ", null, 123, {}]) {
      const migrated = migrateWorldConfig({
        worldName: "w",
        centerLocationId: bad as never,
        locations: [],
      });
      expect(migrated.centerLocationId).toBe("main_area");
    }
  });

  it("centerLocationId 前后空白会被去掉", () => {
    const migrated = migrateWorldConfig({
      worldName: "w",
      centerLocationId: "  town_square  ",
      locations: [],
    });
    expect(migrated.centerLocationId).toBe("town_square");
  });

  it("键位不齐的真实世界能正常迁移", () => {
    // 真实世界的 world.json 顶层键本来就不齐。
    const real = {
      worldName: "汴京夜市异人录",
      worldDescription: "北宋汴京的夜市街上……",
      contentLanguage: "zh",
      originalPrompt: "北宋汴京的一条夜市街",
      scene: { sceneType: "open" },
      worldActions: [],
      locations: [
        { id: "main_area", name: "主区域", description: "d", adjacentLocations: ["pawnshop_interior"], objects: [] },
        { id: "pawnshop_interior", name: "当铺", description: "d", adjacentLocations: ["main_area"], objects: [] },
      ],
      mainAreaPoints: [],
      worldSize: { width: 100, height: 100 },
      weather: { preset: "clear" },
      hearsay: { enabled: false },
      metadata: { worldName: "汴京夜市异人录" },
    };
    const migrated = migrateWorldConfig(real);
    expect(migrated.schemaVersion).toBe(WORLD_SCHEMA_VERSION);
    expect(migrated.centerLocationId).toBe("main_area");
    expect(migrated.locations).toHaveLength(2);
  });
});
