import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { repairWorld } from "./repair-world-locations.mjs";

/**
 * `repair-world-locations.mjs` 的行为。
 *
 * ## 这个脚本修什么
 *
 * 客户端（MapManager）从 TMJ 读区域，服务端（WorldManager）从 world.json 读地点。
 * 两边 id 对不上就会出现「看得见但用不了」的区域。
 *
 * 脚本的规则：
 *
 *   1. TMJ 里每个 region，都要在 world.json 里有一个同 id 的 location
 *   2. world.json 里除中心区域外的 location，都要有对应的 TMJ region
 *   3. 中心区域允许没有 TMJ region（它是「公共枢纽」概念）
 *   4. 顺带用规范算法重建 mainAreaPoints
 */

function makeTiled(opts: {
  width?: number;
  height?: number;
  regions: { id: string; name: string; x: number; y: number; w: number; h: number }[];
  objects?: { objectId: string; name: string; x: number; y: number; w: number; h: number }[];
}) {
  const width = opts.width ?? 20;
  const height = opts.height ?? 20;
  return {
    width,
    height,
    tilewidth: 32,
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
            { name: "description", value: `${r.name}的描述` },
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

function makeWorldDir(
  tmj: ReturnType<typeof makeTiled>,
  worldJson: Record<string, unknown>,
) {
  const dir = mkdtempSync(join(tmpdir(), "worldx-repair-"));
  mkdirSync(join(dir, "map"), { recursive: true });
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(join(dir, "map", "06-final.tmj"), JSON.stringify(tmj), "utf-8");
  writeFileSync(join(dir, "config", "world.json"), JSON.stringify(worldJson, null, 2), "utf-8");
  return dir;
}

describe("repairWorld", () => {
  let dir: string | null = null;

  beforeEach(() => {
    dir = null;
  });

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("TMJ 里有、world.json 里没有的区域会被补上", async () => {
    const tmj = makeTiled({
      regions: [
        { id: "town_market_square", name: "镇心集市", x: 100, y: 100, w: 200, h: 200 },
        { id: "riverside_tea_shed", name: "临河茶棚", x: 400, y: 400, w: 100, h: 100 },
      ],
    });
    dir = makeWorldDir(tmj, {
      centerLocationId: "main_area",
      locations: [
        {
          id: "main_area",
          name: "主区域",
          description: "公共活动区域",
          adjacentLocations: ["riverside_tea_shed"],
          objects: [],
        },
        {
          id: "riverside_tea_shed",
          name: "临河茶棚",
          description: "沿河搭建的简易茶棚。",
          adjacentLocations: ["main_area"],
          objects: [],
        },
      ],
    });

    await repairWorld(dir);

    const after = JSON.parse(
      readFileSync(join(dir, "config", "world.json"), "utf-8"),
    );
    const ids = after.locations.map((l: any) => l.id);
    expect(ids).toContain("town_market_square");
    expect(ids).toContain("riverside_tea_shed");
    expect(ids).toContain("main_area");
  });

  it("中心区域连到所有其它区域（双向可达）", async () => {
    const tmj = makeTiled({
      regions: [
        { id: "town_market_square", name: "镇心集市", x: 100, y: 100, w: 200, h: 200 },
        { id: "riverside_tea_shed", name: "临河茶棚", x: 400, y: 400, w: 100, h: 100 },
      ],
    });
    dir = makeWorldDir(tmj, {
      centerLocationId: "main_area",
      locations: [
        {
          id: "main_area",
          name: "主区域",
          description: "公共活动区域",
          // **故意漏掉 town_market_square** —— 修复脚本要把它补上，
          // 否则角色在 main_area 看不到这个选项，走不进去。
          adjacentLocations: ["riverside_tea_shed"],
          objects: [],
        },
        {
          id: "riverside_tea_shed",
          name: "临河茶棚",
          description: "沿河搭建的简易茶棚。",
          adjacentLocations: ["main_area"],
          objects: [],
        },
      ],
    });

    await repairWorld(dir);

    const after = JSON.parse(
      readFileSync(join(dir, "config", "world.json"), "utf-8"),
    );
    const center = after.locations.find((l: any) => l.id === "main_area");
    expect(center.adjacentLocations).toContain("town_market_square");
    expect(center.adjacentLocations).toContain("riverside_tea_shed");
  });

  it("world.json 里有、TMJ 里没有的地点会被移除（地图上不存在）", async () => {
    const tmj = makeTiled({
      regions: [{ id: "riverside_tea_shed", name: "临河茶棚", x: 400, y: 400, w: 100, h: 100 }],
    });
    dir = makeWorldDir(tmj, {
      centerLocationId: "main_area",
      locations: [
        {
          id: "main_area",
          name: "主区域",
          description: "公共活动区域",
          adjacentLocations: [],
          objects: [],
        },
        {
          id: "riverside_tea_shed",
          name: "临河茶棚",
          description: "沿河搭建的简易茶棚。",
          adjacentLocations: ["main_area"],
          objects: [],
        },
        {
          id: "ghost_location",
          name: "幽灵地点",
          description: "地图上并不存在。",
          adjacentLocations: ["main_area"],
          objects: [],
        },
      ],
    });

    await repairWorld(dir);

    const after = JSON.parse(
      readFileSync(join(dir, "config", "world.json"), "utf-8"),
    );
    const ids = after.locations.map((l: any) => l.id);
    expect(ids).not.toContain("ghost_location");
    expect(ids).toContain("riverside_tea_shed");
  });

  it("dry-run 不写盘", async () => {
    const tmj = makeTiled({
      regions: [{ id: "town_market_square", name: "镇心集市", x: 100, y: 100, w: 200, h: 200 }],
    });
    dir = makeWorldDir(tmj, {
      centerLocationId: "main_area",
      locations: [
        {
          id: "main_area",
          name: "主区域",
          description: "公共活动区域",
          adjacentLocations: [],
          objects: [],
        },
      ],
    });

    const before = readFileSync(join(dir, "config", "world.json"), "utf-8");
    const { notes } = await repairWorld(dir, { dryRun: true });
    const after = readFileSync(join(dir, "config", "world.json"), "utf-8");

    expect(after).toBe(before);
    expect(notes.length).toBeGreaterThan(0);
  });

  it("中心区域的物件不被丢掉", async () => {
    const tmj = makeTiled({
      regions: [{ id: "town_market_square", name: "镇心集市", x: 100, y: 100, w: 200, h: 200 }],
    });
    dir = makeWorldDir(tmj, {
      centerLocationId: "main_area",
      locations: [
        {
          id: "main_area",
          name: "主区域",
          description: "公共活动区域",
          adjacentLocations: [],
          objects: [{ id: "tea_counter", name: "曲尺柜台", locationId: "main_area" }],
        },
      ],
    });

    await repairWorld(dir);

    const after = JSON.parse(
      readFileSync(join(dir, "config", "world.json"), "utf-8"),
    );
    const center = after.locations.find((l: any) => l.id === "main_area");
    expect(center.objects.map((o: any) => o.id)).toContain("tea_counter");
  });
});
