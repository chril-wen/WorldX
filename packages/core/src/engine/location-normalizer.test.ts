import { describe, it, expect } from "vitest";
import type { LocationConfig } from "../contracts/index.js";

/**
 * 区域归一化 —— **改造前的行为基准**。
 *
 * ## 为什么这个文件先写
 *
 * 阶段 4 要把 `main_area` 这个写死的 id 换成 `centerLocationId`（world.json 声明）。
 * 但归一化逻辑**有两条一模一样的实现**：
 *
 * - `packages/core/src/engine/world-manager.ts` 的 `normalizeLocations`
 * - `orchestrator/src/config-generator.mjs` 的 `finalizeLocations`
 *
 * 逐字相同，连错误都一样。而且**两边都没有测试** ——
 * 改错了不会红，只会让世界悄悄变形。
 *
 * 所以这个文件的作用是**先锁住改造前的行为**：
 * 下面的 `legacyNormalizeLocations` 是**照抄改造前的代码**，
 * 不是从新实现反推的。改造后新实现必须跟它逐点一致。
 *
 * 基准里 `main_area` 是写死的 —— 因为改造前它就是写死的。
 * 改造后新实现要接受任意中心 id，但**默认路径**（id = "main_area"）
 * 必须跟基准完全一致。
 */

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

// ─── 改造前的原始实现（照抄） ────────────────────────────────────────────

function legacyNormalizeLocations(
  locations: LocationConfig[] | undefined,
  worldName: string,
  worldDescription: string,
): LocationConfig[] {
  const authored = (Array.isArray(locations) ? locations : []).map((location) => ({
    ...location,
    adjacentLocations: Array.isArray(location.adjacentLocations)
      ? unique(location.adjacentLocations.filter(Boolean))
      : [],
    objects: Array.isArray(location.objects) ? location.objects : [],
  }));

  const authoredIds = authored
    .map((location) => location.id)
    .filter((locationId) => locationId && locationId !== "main_area");

  const hasMainArea = authored.some((location) => location.id === "main_area");
  const withMainArea = hasMainArea
    ? authored
    : [
        {
          id: "main_area",
          name: "主区域",
          description: worldDescription || `${worldName}中的公共活动区域`,
          adjacentLocations: [...authoredIds],
          objects: [],
        },
        ...authored,
      ];

  const allIds = new Set(withMainArea.map((location) => location.id));
  const hasAnyAuthoredAdjacency = withMainArea.some(
    (location) =>
      location.id !== "main_area" && (location.adjacentLocations?.length ?? 0) > 0,
  );

  return withMainArea.map((location) => {
    let adjacent = (location.adjacentLocations ?? []).filter(
      (adjacentId) => adjacentId !== location.id && allIds.has(adjacentId),
    );

    if (location.id === "main_area") {
      adjacent = unique([...adjacent, ...authoredIds]);
    } else if (adjacent.length === 0) {
      adjacent = hasAnyAuthoredAdjacency
        ? ["main_area"]
        : Array.from(allIds).filter((adjacentId) => adjacentId !== location.id);
    } else {
      adjacent = unique(["main_area", ...adjacent]);
    }

    return {
      ...location,
      adjacentLocations: adjacent,
    };
  });
}

// ─── 测试脚手架 ──────────────────────────────────────────────────────────

function loc(
  id: string,
  adjacent: string[] = [],
  extra: Partial<LocationConfig> = {},
): LocationConfig {
  return {
    id,
    name: `区域${id}`,
    description: `${id}的描述`,
    adjacentLocations: adjacent,
    objects: [],
    ...extra,
  };
}

// ─── 基准行为本身（这些断言在改造前就该通过） ───────────────────────────

describe("区域归一化 —— 改造前的行为基准", () => {
  it("没有主区域时补一个，并连到所有其它区域", () => {
    const result = legacyNormalizeLocations(
      [loc("a"), loc("b")],
      "测试世界",
      "世界描述",
    );
    const main = result.find((l) => l.id === "main_area");
    expect(main).toBeDefined();
    expect(main!.adjacentLocations).toEqual(["a", "b"]);
    expect(main!.name).toBe("主区域");
  });

  it("已经有主区域时不重复补", () => {
    const result = legacyNormalizeLocations(
      [loc("main_area"), loc("a")],
      "测试世界",
      "世界描述",
    );
    expect(result.filter((l) => l.id === "main_area").length).toBe(1);
  });

  it("已有主区域不会被排在最前面（保持作者顺序）", () => {
    const result = legacyNormalizeLocations(
      [loc("a"), loc("main_area"), loc("b")],
      "测试世界",
      "世界描述",
    );
    expect(result.map((l) => l.id)).toEqual(["a", "main_area", "b"]);
  });

  it("都没写邻接时：全连接（中心 + 其它区域之间也连上）", () => {
    // 基准行为：只要有**任何一个**区域写了邻接，无邻接的区域才只挂中心；
    // 一个都没写时走全连接分支。
    const result = legacyNormalizeLocations(
      [loc("a"), loc("b")],
      "测试世界",
      "世界描述",
    );
    const a = result.find((l) => l.id === "a")!;
    const b = result.find((l) => l.id === "b")!;
    expect(a.adjacentLocations).toEqual(["main_area", "b"]);
    expect(b.adjacentLocations).toEqual(["main_area", "a"]);
  });

  it("有人写了邻接时，没写邻接的只挂中心区域", () => {
    const result = legacyNormalizeLocations(
      [loc("a"), loc("b", ["c"]), loc("c")],
      "测试世界",
      "世界描述",
    );
    const a = result.find((l) => l.id === "a")!;
    expect(a.adjacentLocations).toEqual(["main_area"]);
  });

  it("已有邻接的区域，主区域排在邻接首位", () => {
    const result = legacyNormalizeLocations(
      [loc("a", ["b"]), loc("b")],
      "测试世界",
      "世界描述",
    );
    const a = result.find((l) => l.id === "a")!;
    expect(a.adjacentLocations).toEqual(["main_area", "b"]);
  });

  it("主区域连到所有其它区域（星形中心）", () => {
    const result = legacyNormalizeLocations(
      [loc("a", ["b"]), loc("b", ["a"]), loc("c")],
      "测试世界",
      "世界描述",
    );
    const main = result.find((l) => l.id === "main_area")!;
    expect(main.adjacentLocations).toEqual(["a", "b", "c"]);
  });

  it("指向不存在的区域的邻接会被丢掉", () => {
    const result = legacyNormalizeLocations(
      [loc("a", ["ghost"]), loc("b")],
      "测试世界",
      "世界描述",
    );
    const a = result.find((l) => l.id === "a")!;
    expect(a.adjacentLocations).not.toContain("ghost");
  });

  it("指向自己的邻接会被丢掉", () => {
    const result = legacyNormalizeLocations(
      [loc("a", ["a", "b"]), loc("b")],
      "测试世界",
      "世界描述",
    );
    const a = result.find((l) => l.id === "a")!;
    expect(a.adjacentLocations).not.toContain("a");
  });

  it("世界描述优先于生成的描述", () => {
    const result = legacyNormalizeLocations([], "测试世界", "真实描述");
    const main = result.find((l) => l.id === "main_area")!;
    expect(main.description).toBe("真实描述");
  });

  it("没有世界描述时用世界名兜底", () => {
    const result = legacyNormalizeLocations([], "测试世界", "");
    const main = result.find((l) => l.id === "main_area")!;
    expect(main.description).toBe("测试世界中的公共活动区域");
  });

  it("locations 不是数组时：仍然补出中心区域", () => {
    // 基准行为：locations 缺失时 `hasCenter` 为 false → 补一个中心区域。
    // 世界**永远**有中心区域（它是公共枢纽的载体），
    // 所以不是返回空数组。
    for (const input of [undefined, null as never]) {
      const result = legacyNormalizeLocations(input, "w", "d");
      expect(result.map((l) => l.id)).toEqual(["main_area"]);
    }
  });

  it("objects 不是数组时归一成空数组", () => {
    const bad = { ...loc("a"), objects: undefined as never };
    const result = legacyNormalizeLocations([bad], "w", "d");
    expect(result.find((l) => l.id === "a")!.objects).toEqual([]);
  });

  it("重复的邻接 id 会去重", () => {
    const result = legacyNormalizeLocations(
      [loc("a", ["b", "b", "b"]), loc("b")],
      "w",
      "d",
    );
    const a = result.find((l) => l.id === "a")!;
    expect(a.adjacentLocations).toEqual(["main_area", "b"]);
  });

  it("主区域不在其它区域的 authoredIds 里", () => {
    // main_area 不该被当成「真实区域」参与邻接计算
    const result = legacyNormalizeLocations(
      [loc("main_area"), loc("a")],
      "w",
      "d",
    );
    // main_area 的邻接只含真实区域 a
    const main = result.find((l) => l.id === "main_area")!;
    expect(main.adjacentLocations).toEqual(["a"]);
  });
});

/**
 * 改造后：新实现接受任意中心 id。
 *
 * 这里的断言是**新增能力** —— 改造前做不到。
 * 默认路径（中心 id = "main_area"）必须跟基准完全一致。
 */
describe("区域归一化 —— 中心 id 可配（改造后新增）", () => {
  it("中心 id 是 town_square 时，补出来的区域用它", async () => {
    const { normalizeLocations } = await import("./location-normalizer.js");
    const result = normalizeLocations([loc("a")], "town_square", "世界描述");
    expect(result.map((l) => l.id)).toContain("town_square");
    expect(result.map((l) => l.id)).not.toContain("main_area");
  });

  it("中心 id 可配时，其它区域挂到它上面", async () => {
    const { normalizeLocations } = await import("./location-normalizer.js");
    // 两个区域都没写邻接 → 走全连接分支，但**中心 id 仍排在首位**
    const result = normalizeLocations(
      [loc("a"), loc("b")],
      "town_square",
      "世界描述",
    );
    const a = result.find((l) => l.id === "a")!;
    expect(a.adjacentLocations[0]).toBe("town_square");
    expect(a.adjacentLocations).not.toContain("main_area");
  });

  it("默认路径跟改造前逐点一致", async () => {
    const { normalizeLocations } = await import("./location-normalizer.js");
    const cases: Array<[LocationConfig[] | undefined, string, string]> = [
      [[loc("a"), loc("b")], "测试世界", "世界描述"],
      [[loc("main_area"), loc("a")], "测试世界", "世界描述"],
      [[loc("a", ["b"]), loc("b")], "测试世界", "世界描述"],
      [[loc("a", ["ghost"]), loc("b")], "测试世界", "世界描述"],
      [[], "测试世界", ""],
      [undefined, "测试世界", "世界描述"],
    ];
    for (const [locations, name, desc] of cases) {
      const expected = legacyNormalizeLocations(locations, name, desc);
      const actual = normalizeLocations(locations, "main_area", name, desc);
      expect(actual).toEqual(expected);
    }
  });
});
