import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateConfigs } from "./config-generator.mjs";

/**
 * 「TMJ 区域」与「world.json 地点」的一致性。
 *
 * ## 为什么要测这个
 *
 * 客户端（`MapManager`）从 TMJ 读区域，服务端（`WorldManager`）从 world.json 读地点。
 * 两边 id 对不上，就会出现「看得见但用不了」的区域 ——
 * 客户端画得出那个框、显示得出它的名字，角色却永远去不了。
 *
 * ## 曾经真实发生过的 bug
 *
 * `buildLocations` 会挑一个「主公共枢纽」区域（`findPrimaryPublicHubRegion`），
 * 把它的 id 从 locations 里**剔除**，改由 `main_area` 承接它的物件。
 *
 * 但 **TMJ 里那个框原封不动留着** —— 于是：
 *
 * - TMJ 有 `town_market_square`，world.json 没有 → 客户端看得见，服务端不认识
 *
 * 修法不是「从 TMJ 删框」（那个框在地图上是真实存在的物理场所），
 * 而是**让 world.json 认下它**。
 */

/** 造一个最小 TMJ */
function makeTiled(opts: {
  width?: number;
  height?: number;
  tilewidth?: number;
  regions: { id: string; name: string; x: number; y: number; w: number; h: number; desc?: string }[];
  objects?: { objectId: string; name: string; x: number; y: number; w: number; h: number }[];
}) {
  const width = opts.width ?? 20;
  const height = opts.height ?? 20;
  return {
    width,
    height,
    tilewidth: opts.tilewidth ?? 32,
    layers: [
      { type: "tilelayer", name: "collision", data: new Array(width * height).fill(0) },
      {
        type: "objectgroup",
        name: "regions",
        objects: opts.regions.map((r) => ({
          name: r.name,
          x: r.x,
          y: r.y,
          width: r.w,
          height: r.h,
          properties: [
            { name: "id", value: r.id },
            { name: "description", value: r.desc ?? "" },
            { name: "regionType", value: "outdoor" },
          ],
        })),
      },
      {
        type: "objectgroup",
        name: "interactive_objects",
        objects: (opts.objects ?? []).map((o) => ({
          name: o.name,
          x: o.x,
          y: o.y,
          width: o.w,
          height: o.h,
          properties: [{ name: "objectId", value: o.objectId }],
        })),
      },
    ],
  };
}

/**
 * 造一个世界目录：TMJ + 空的 world-design。
 *
 * `generateConfigs` 会读 TMJ、生成 world.json。
 */
function makeWorldDir(tmj: ReturnType<typeof makeTiled>) {
  const dir = mkdtempSync(join(tmpdir(), "worldx-loc-"));
  mkdirSync(join(dir, "map"), { recursive: true });
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(join(dir, "map", "06-final.tmj"), JSON.stringify(tmj), "utf-8");
  return dir;
}

/** 一个包含「公共枢纽候选」的设计 */
const DESIGN_WITH_HUB = {
  worldName: "测试镇",
  worldDescription: "一个用来测试地点一致性的镇子。",
  regions: [
    { id: "town_market_square", name: "镇心集市", description: "早集与摊贩汇聚的空地。" },
    { id: "riverside_tea_shed", name: "临河茶棚", description: "沿河搭建的简易茶棚。" },
  ],
  characters: [],
  interactiveElements: [],
};

describe("generateConfigs：TMJ 区域与 world.json 地点一致", () => {
  let dir: string | null = null;

  beforeEach(() => {
    dir = null;
  });

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("TMJ 里每个区域都在 world.json 里有同 id 的地点", async () => {
    const tmj = makeTiled({
      regions: [
        // 「镇心集市」—— id 含 "square"，命中 PUBLIC_HUB_KEYWORDS，
        // 会被 findPrimaryPublicHubRegion 挑成主公共枢纽
        { id: "town_market_square", name: "镇心集市", x: 100, y: 100, w: 200, h: 200 },
        { id: "riverside_tea_shed", name: "临河茶棚", x: 400, y: 400, w: 100, h: 100 },
      ],
    });
    dir = makeWorldDir(tmj);

    const configs = await generateConfigs(DESIGN_WITH_HUB, dir);
    const worldJson = JSON.parse(
      readFileSync(join(dir, "config", "world.json"), "utf-8"),
    );

    const tmjRegionIds = tmj.layers
      .find((l: any) => l.name === "regions")
      .objects.map((o: any) => o.properties.find((p: any) => p.name === "id").value);

    const locationIds = worldJson.locations.map((l: any) => l.id);

    // **核心断言**：TMJ 的每个区域，world.json 里都要有同 id 的地点。
    // 少一个 = 客户端看得见但服务端不认识。
    for (const regionId of tmjRegionIds) {
      expect(
        locationIds,
        `TMJ 区域「${regionId}」在 world.json 里没有对应地点 —— 客户端会画它但服务端不认识`,
      ).toContain(regionId);
    }
  });

  it("主公共枢纽区域不再被丢出 locations", async () => {
    const tmj = makeTiled({
      regions: [
        { id: "town_market_square", name: "镇心集市", x: 100, y: 100, w: 200, h: 200 },
        { id: "riverside_tea_shed", name: "临河茶棚", x: 400, y: 400, w: 100, h: 100 },
      ],
    });
    dir = makeWorldDir(tmj);

    await generateConfigs(DESIGN_WITH_HUB, dir);
    const worldJson = JSON.parse(
      readFileSync(join(dir, "config", "world.json"), "utf-8"),
    );

    expect(worldJson.locations.map((l: any) => l.id)).toContain("town_market_square");
  });

  it("中心区域 main_area 仍然存在（逻辑枢纽没被破坏）", async () => {
    const tmj = makeTiled({
      regions: [
        { id: "town_market_square", name: "镇心集市", x: 100, y: 100, w: 200, h: 200 },
        { id: "riverside_tea_shed", name: "临河茶棚", x: 400, y: 400, w: 100, h: 100 },
      ],
    });
    dir = makeWorldDir(tmj);

    await generateConfigs(DESIGN_WITH_HUB, dir);
    const worldJson = JSON.parse(
      readFileSync(join(dir, "config", "world.json"), "utf-8"),
    );

    expect(worldJson.locations.map((l: any) => l.id)).toContain("main_area");
    expect(worldJson.centerLocationId).toBe("main_area");
  });

  it("中心区域连到所有真实区域（含主公共枢纽）", async () => {
    const tmj = makeTiled({
      regions: [
        { id: "town_market_square", name: "镇心集市", x: 100, y: 100, w: 200, h: 200 },
        { id: "riverside_tea_shed", name: "临河茶棚", x: 400, y: 400, w: 100, h: 100 },
      ],
    });
    dir = makeWorldDir(tmj);

    await generateConfigs(DESIGN_WITH_HUB, dir);
    const worldJson = JSON.parse(
      readFileSync(join(dir, "config", "world.json"), "utf-8"),
    );

    const mainArea = worldJson.locations.find((l: any) => l.id === "main_area");
    expect(mainArea.adjacentLocations).toContain("town_market_square");
    expect(mainArea.adjacentLocations).toContain("riverside_tea_shed");
  });

  it("没有 hub 候选时行为不变（不凭空多出地点）", async () => {
    const tmj = makeTiled({
      regions: [
        { id: "riverside_tea_shed", name: "临河茶棚", x: 400, y: 400, w: 100, h: 100 },
      ],
    });
    dir = makeWorldDir(tmj);

    await generateConfigs(
      {
        ...DESIGN_WITH_HUB,
        regions: [{ id: "riverside_tea_shed", name: "临河茶棚", description: "沿河搭建的简易茶棚。" }],
      },
      dir,
    );
    const worldJson = JSON.parse(
      readFileSync(join(dir, "config", "world.json"), "utf-8"),
    );

    const locationIds = worldJson.locations.map((l: any) => l.id).sort();
    expect(locationIds).toEqual(["main_area", "riverside_tea_shed"]);
  });
});
