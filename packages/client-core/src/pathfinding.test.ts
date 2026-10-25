import { describe, it, expect, beforeEach } from "vitest";
import { MapManager } from "./map-model.js";
import { PathfindingManager } from "./pathfinding.js";

/**
 * 造一个最小可用的 Tiled JSON（跟 map-model.test.ts 里同一个 helper）。
 *
 * collision 层：data 里 0 = 可走，1 = 阻挡。
 */
function makeTiled(opts: {
  width?: number;
  height?: number;
  tilewidth?: number;
  collision?: number[];
  regions?: { id: string; name: string; x: number; y: number; w: number; h: number }[];
  objects?: { objectId: string; name: string; x: number; y: number; w: number; h: number }[];
} = {}) {
  const width = opts.width ?? 10;
  const height = opts.height ?? 10;
  const tilewidth = opts.tilewidth ?? 32;
  const collision = opts.collision ?? new Array(width * height).fill(0);
  return {
    width,
    height,
    tilewidth,
    layers: [
      { type: "tilelayer", name: "collision", data: collision },
      {
        type: "objectgroup",
        name: "regions",
        objects: (opts.regions ?? []).map((r) => ({
          name: r.name,
          x: r.x,
          y: r.y,
          width: r.w,
          height: r.h,
          properties: [{ name: "id", value: r.id }],
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

/** 网格坐标的像素中心 */
function px(gx: number, gy: number, tile = 32) {
  return { x: gx * tile + tile / 2, y: gy * tile + tile / 2 };
}

/**
 * 把路径折成网格坐标序列 —— 断言这个比断言像素好读。
 */
function toGrid(path: Array<{ x: number; y: number }> | null) {
  if (!path) return null;
  return path.map((p) => ({ gx: Math.floor(p.x / 32), gy: Math.floor(p.y / 32) }));
}

describe("PathfindingManager", () => {
  let mm: MapManager;
  let pf: PathfindingManager;

  beforeEach(() => {
    mm = new MapManager();
  });

  describe("findPath", () => {
    it("空地图上找到一条直路", async () => {
      mm.loadFromTiledJSON(makeTiled({ width: 10, height: 10 }));
      pf = new PathfindingManager(mm);

      const path = await pf.findPath(px(0, 0).x, px(0, 0).y, px(5, 0).x, px(5, 0).y);
      expect(path).not.toBeNull();
      expect(toGrid(path)).toEqual([
        { gx: 0, gy: 0 },
        { gx: 5, gy: 0 },
      ]);
    });

    it("起点即终点时返回空数组", async () => {
      mm.loadFromTiledJSON(makeTiled({ width: 10, height: 10 }));
      pf = new PathfindingManager(mm);

      // easystar 在起点==终点时返回**空数组**，不是单点。
      // 这是实测行为（不是猜的）—— 详见 ab-comparison.test.ts 的同类用例。
      const path = await pf.findPath(px(3, 3).x, px(3, 3).y, px(3, 3).x, px(3, 3).y);
      expect(path).toEqual([]);
    });

    it("终点被阻挡时挪到最近的可走格", async () => {
      const collision = new Array(100).fill(0);
      collision[5 * 10 + 5] = 1; // (5,5) 阻挡
      mm.loadFromTiledJSON(makeTiled({ width: 10, height: 10, collision }));
      pf = new PathfindingManager(mm);

      const path = await pf.findPath(px(0, 0).x, px(0, 0).y, px(5, 5).x, px(5, 5).y);
      expect(path).not.toBeNull();
      // 终点必须落在某个可走格上
      const last = toGrid(path)!.at(-1)!;
      expect(mm.isWalkable(last.gx, last.gy)).toBe(true);
    });

    it("四周全堵时返回 null", async () => {
      const collision = new Array(100).fill(0);
      // 把 (0,0) 封死
      collision[0] = 1;
      collision[1] = 1;
      collision[10] = 1;
      mm.loadFromTiledJSON(makeTiled({ width: 10, height: 10, collision }));
      pf = new PathfindingManager(mm);

      const path = await pf.findPath(px(0, 0).x, px(0, 0).y, px(5, 5).x, px(5, 5).y);
      expect(path).toBeNull();
    });

    it("路径的每一段都是可走的（不穿墙）", async () => {
      const collision = new Array(100).fill(0);
      // 一道竖墙，中间留个洞
      for (let y = 0; y < 10; y++) {
        if (y === 5) continue;
        collision[y * 10 + 5] = 1;
      }
      mm.loadFromTiledJSON(makeTiled({ width: 10, height: 10, collision }));
      pf = new PathfindingManager(mm);

      const path = await pf.findPath(px(1, 1).x, px(1, 1).y, px(9, 8).x, px(9, 8).y);
      expect(path).not.toBeNull();

      // 逐点检查：每个路径点所在格都可走
      for (const p of toGrid(path)!) {
        expect(mm.isWalkable(p.gx, p.gy)).toBe(true);
      }
    });

    it("路径首尾分别是起点和终点", async () => {
      mm.loadFromTiledJSON(makeTiled({ width: 10, height: 10 }));
      pf = new PathfindingManager(mm);

      const path = await pf.findPath(px(1, 2).x, px(1, 2).y, px(8, 6).x, px(8, 6).y);
      const grid = toGrid(path)!;
      expect(grid[0]).toEqual({ gx: 1, gy: 2 });
      expect(grid.at(-1)).toEqual({ gx: 8, gy: 6 });
    });

    it("路径是轴对齐的（每段都是横或竖，不斜着走）", async () => {
      mm.loadFromTiledJSON(makeTiled({ width: 10, height: 10 }));
      pf = new PathfindingManager(mm);

      const path = await pf.findPath(px(0, 0).x, px(0, 0).y, px(7, 4).x, px(7, 4).y);
      const grid = toGrid(path)!;

      // 简化后的路径**每段可以跨多格** —— 它是「几个转折点」，
      // 不是「逐格走过的轨迹」。所以不能断言相邻点只差一格。
      // 能断言的是：每一步要么 x 变要么 y 变，但不能同时变（不斜着走）。
      for (let i = 1; i < grid.length; i++) {
        const dx = Math.abs(grid[i].gx - grid[i - 1].gx);
        const dy = Math.abs(grid[i].gy - grid[i - 1].gy);
        expect(dx + dy).toBeGreaterThan(0);
        expect(dx === 0 || dy === 0).toBe(true);
      }
    });

    it("每一段都穿过可走的格子（不穿墙）", async () => {
      const collision = new Array(100).fill(0);
      // 一道竖墙，中间留个洞
      for (let y = 0; y < 10; y++) {
        if (y === 5) continue;
        collision[y * 10 + 5] = 1;
      }
      mm.loadFromTiledJSON(makeTiled({ width: 10, height: 10, collision }));
      pf = new PathfindingManager(mm);

      const path = await pf.findPath(px(1, 1).x, px(1, 1).y, px(9, 8).x, px(9, 8).y);
      const grid = toGrid(path)!;

      // 段与段之间可能跨格，所以要**逐格**检查中间那一段
      for (let i = 1; i < grid.length; i++) {
        const from = grid[i - 1];
        const to = grid[i];
        const steps = Math.max(Math.abs(to.gx - from.gx), Math.abs(to.gy - from.gy));
        const stepX = Math.sign(to.gx - from.gx);
        const stepY = Math.sign(to.gy - from.gy);
        for (let s = 0; s <= steps; s++) {
          expect(mm.isWalkable(from.gx + stepX * s, from.gy + stepY * s)).toBe(true);
        }
      }
    });

    it("楼梯路径被重塑成更少的转弯", async () => {
      // 造一个逼出楼梯重塑的格局：**够宽**的斜向通道。
      //
      // 关键在宽度 —— reshapeStaircaseRun 一次批 2 步（STAIRCASE_BATCH_SIZE），
      // 通道得容得下这 2 步的横向位移才重塑得动。实测：
      //   2 格宽 → 27 点 / 25 转弯（重塑不动）
      //   3 格宽 → 15 点 / 13 转弯
      //   4 格宽 → 11 点 / 9  转弯（重塑到位）
      const width = 20;
      const height = 20;
      const collision = new Array(width * height).fill(1);
      // 4 条平行的对角带：x - y ∈ [-3, 0]
      for (let y = 0; y < 15; y++) {
        for (let x = 0; x < 15; x++) {
          if (x - y >= -3 && x - y <= 0) collision[y * width + x] = 0;
        }
      }
      mm.loadFromTiledJSON(makeTiled({ width, height, collision }));
      pf = new PathfindingManager(mm);

      const path = await pf.findPath(px(0, 0).x, px(0, 0).y, px(13, 13).x, px(13, 13).y);
      expect(path).not.toBeNull();

      const grid = toGrid(path)!;
      // 统计转弯次数（横竖交替）
      let turns = 0;
      let prevAxis: "h" | "v" | null = null;
      for (let i = 1; i < grid.length; i++) {
        const axis = grid[i].gx !== grid[i - 1].gx ? "h" : "v";
        if (prevAxis && axis !== prevAxis) turns++;
        prevAxis = axis;
      }
      // 楼梯重塑的目的：转弯次数远少于逐格走的次数。
      // 逐格走这条对角线要 26 步 25 转；重塑后 11 点 9 转。
      expect(turns).toBeLessThan(10);
    });
  });

  describe("findPathToObject", () => {
    it("走到物件正下方的站位", async () => {
      mm.loadFromTiledJSON(
        makeTiled({
          width: 10,
          height: 10,
          objects: [{ objectId: "obj_tea", name: "茶壶", x: 64, y: 96, w: 32, h: 32 }],
        }),
      );
      pf = new PathfindingManager(mm);

      const path = await pf.findPathToObject(px(0, 0).x, px(0, 0).y, "obj_tea");
      expect(path).not.toBeNull();
      // 站位 = obj.x + w/2, obj.y + h + tileSize = 80, 160 → 格 (2, 5)
      expect(toGrid(path)!.at(-1)).toEqual({ gx: 2, gy: 5 });
    });

    it("物件不存在时返回 null", async () => {
      mm.loadFromTiledJSON(makeTiled({ width: 10, height: 10 }));
      pf = new PathfindingManager(mm);

      expect(await pf.findPathToObject(px(0, 0).x, px(0, 0).y, "不存在")).toBeNull();
    });
  });

  describe("findPathToLocation", () => {
    it("能走到区域内的一个可走点", async () => {
      mm.loadFromTiledJSON(
        makeTiled({
          width: 10,
          height: 10,
          regions: [{ id: "alley", name: "巷口", x: 0, y: 0, w: 320, h: 320 }],
        }),
      );
      pf = new PathfindingManager(mm);

      const path = await pf.findPathToLocation(px(0, 0).x, px(0, 0).y, "alley");
      expect(path).not.toBeNull();
      const last = toGrid(path)!.at(-1)!;
      expect(mm.isWalkable(last.gx, last.gy)).toBe(true);
    });

    it("地点不存在时退到全图随机可走点（不是 null）", async () => {
      mm.loadFromTiledJSON(makeTiled({ width: 10, height: 10 }));
      pf = new PathfindingManager(mm);

      // `getRandomWalkablePointInLocation` 找不到地点时**退回全图随机点**
      // （跟 `isPinnedLocation` 为假时一样），不是返回 null。
      // 所以这里的行为是「能走到某个可走点」。
      const path = await pf.findPathToLocation(px(0, 0).x, px(0, 0).y, "不存在");
      expect(path).not.toBeNull();
      const last = toGrid(path)!.at(-1)!;
      expect(mm.isWalkable(last.gx, last.gy)).toBe(true);
    });
  });

  describe("update", () => {
    it("可以重复调用不抛错", () => {
      mm.loadFromTiledJSON(makeTiled({ width: 10, height: 10 }));
      pf = new PathfindingManager(mm);
      expect(() => {
        pf.update();
        pf.update();
      }).not.toThrow();
    });
  });
});
