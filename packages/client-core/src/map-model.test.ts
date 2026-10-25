import { describe, it, expect, beforeEach } from "vitest";
import { MapManager } from "./map-model.js";

/**
 * 造一个最小可用的 Tiled JSON：
 * - collision 层：data 里 0 = 可走，1 = 阻挡
 * - regions 层：objectgroup，每个对象带 properties 里的 id
 * - interactive_objects 层：objectgroup，每个对象带 properties 里的 objectId
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

describe("MapManager", () => {
  let mm: MapManager;

  beforeEach(() => {
    mm = new MapManager();
  });

  describe("loadFromTiledJSON", () => {
    it("读入网格尺寸与 tile 尺寸", () => {
      mm.loadFromTiledJSON(makeTiled({ width: 20, height: 15, tilewidth: 16 }));
      expect(mm.gridWidth).toBe(20);
      expect(mm.gridHeight).toBe(15);
      expect(mm.tileSize).toBe(16);
    });

    it("没有 tilewidth 时用默认 TILE_SIZE", () => {
      const json = makeTiled();
      delete (json as any).tilewidth;
      mm.loadFromTiledJSON(json);
      expect(mm.tileSize).toBe(32);
    });

    it("collision 层非 0 视为阻挡", () => {
      const collision = new Array(100).fill(0);
      collision[11] = 1; // (x=1, y=1)
      mm.loadFromTiledJSON(makeTiled({ collision }));
      expect(mm.isWalkable(1, 1)).toBe(false);
      expect(mm.isWalkable(0, 0)).toBe(true);
    });

    it("没有 regions 层时合成一个 main_area", () => {
      mm.loadFromTiledJSON(makeTiled());
      const loc = mm.getLocationAtPixel(10, 10);
      expect(loc).toBe("main_area");
      expect(mm.locations.get("main_area")!.synthetic).toBe(true);
    });

    it("有 regions 时不合成 main_area", () => {
      mm.loadFromTiledJSON(
        makeTiled({
          regions: [{ id: "teahouse", name: "茶馆", x: 0, y: 0, w: 100, h: 100 }],
        }),
      );
      expect(mm.locations.has("main_area")).toBe(false);
      expect(mm.locations.has("teahouse")).toBe(true);
    });

    it("区域名取自对象 name", () => {
      mm.loadFromTiledJSON(
        makeTiled({
          regions: [{ id: "alley", name: "巷口", x: 0, y: 0, w: 32, h: 32 }],
        }),
      );
      expect(mm.getLocationName("alley")).toBe("巷口");
    });

    it("没有 id 属性的区域对象被跳过", () => {
      const json = makeTiled();
      (json.layers[1] as any).objects = [
        { name: "无 id", x: 0, y: 0, width: 1, height: 1, properties: [] },
      ];
      mm.loadFromTiledJSON(json);
      expect(mm.locations.size).toBe(1);
      expect(mm.locations.has("main_area")).toBe(true);
    });

    it("解析交互物件", () => {
      mm.loadFromTiledJSON(
        makeTiled({
          objects: [
            { objectId: "obj_tea", name: "茶壶", x: 64, y: 96, w: 32, h: 32 },
          ],
        }),
      );
      expect(mm.interactiveObjects.size).toBe(1);
      expect(mm.getObjectPosition("obj_tea")).toEqual({ x: 64, y: 96 });
    });

    it("重复 load 会清空上一次的区域与物件", () => {
      mm.loadFromTiledJSON(
        makeTiled({
          regions: [{ id: "a", name: "A", x: 0, y: 0, w: 10, h: 10 }],
          objects: [{ objectId: "o1", name: "O", x: 1, y: 1, w: 1, h: 1 }],
        }),
      );
      mm.loadFromTiledJSON(makeTiled());
      expect(mm.locations.size).toBe(1);
      expect(mm.interactiveObjects.size).toBe(0);
    });
  });

  describe("pixelToGrid / gridToPixel", () => {
    beforeEach(() => {
      mm.loadFromTiledJSON(makeTiled({ tilewidth: 32 }));
    });

    it("像素转网格取整除", () => {
      expect(mm.pixelToGrid(0, 0)).toEqual({ gx: 0, gy: 0 });
      expect(mm.pixelToGrid(31, 31)).toEqual({ gx: 0, gy: 0 });
      expect(mm.pixelToGrid(32, 32)).toEqual({ gx: 1, gy: 1 });
      expect(mm.pixelToGrid(63, 95)).toEqual({ gx: 1, gy: 2 });
    });

    it("网格转像素落在格子中心", () => {
      expect(mm.gridToPixel(0, 0)).toEqual({ x: 16, y: 16 });
      expect(mm.gridToPixel(1, 2)).toEqual({ x: 48, y: 80 });
    });

    it("像素↔网格往返一致", () => {
      const g = { gx: 3, gy: 7 };
      const p = mm.gridToPixel(g.gx, g.gy);
      expect(mm.pixelToGrid(p.x, p.y)).toEqual(g);
    });
  });

  describe("isWalkable", () => {
    beforeEach(() => {
      const collision = new Array(100).fill(0);
      collision[22] = 1; // (2,2)
      mm.loadFromTiledJSON(makeTiled({ collision }));
    });

    it("0 碰撞值可走", () => {
      expect(mm.isWalkable(0, 0)).toBe(true);
    });

    it("非 0 碰撞值不可走", () => {
      expect(mm.isWalkable(2, 2)).toBe(false);
    });

    it("越界不可走（不抛错）", () => {
      expect(mm.isWalkable(-1, 0)).toBe(false);
      expect(mm.isWalkable(0, -1)).toBe(false);
      expect(mm.isWalkable(10, 0)).toBe(false);
      expect(mm.isWalkable(0, 10)).toBe(false);
    });
  });

  describe("hasWalkableLine", () => {
    it("两点之间无阻挡时可达", () => {
      mm.loadFromTiledJSON(makeTiled());
      expect(
        mm.hasWalkableLine({ gx: 0, gy: 0 }, { gx: 5, gy: 5 }),
      ).toBe(true);
    });

    it("直线上有阻挡时不可达", () => {
      const collision = new Array(100).fill(0);
      for (let x = 0; x <= 5; x++) collision[x] = 1; // 一行全挡
      mm.loadFromTiledJSON(makeTiled({ collision }));
      expect(
        mm.hasWalkableLine({ gx: 0, gy: 0 }, { gx: 5, gy: 0 }),
      ).toBe(false);
    });

    it("起点本身不可走时不可达", () => {
      const collision = new Array(100).fill(0);
      collision[0] = 1;
      mm.loadFromTiledJSON(makeTiled({ collision }));
      expect(
        mm.hasWalkableLine({ gx: 0, gy: 0 }, { gx: 5, gy: 5 }),
      ).toBe(false);
    });
  });

  describe("getLocationAtPixel", () => {
    it("命中区域返回区域 id", () => {
      mm.loadFromTiledJSON(
        makeTiled({
          regions: [
            { id: "alley", name: "巷口", x: 0, y: 0, w: 64, h: 64 },
            { id: "teahouse", name: "茶馆", x: 64, y: 0, w: 64, h: 64 },
          ],
        }),
      );
      expect(mm.getLocationAtPixel(10, 10)).toBe("alley");
      expect(mm.getLocationAtPixel(100, 10)).toBe("teahouse");
    });

    it("不在任何区域时返回 null", () => {
      mm.loadFromTiledJSON(
        makeTiled({
          regions: [{ id: "alley", name: "巷口", x: 0, y: 0, w: 32, h: 32 }],
        }),
      );
      expect(mm.getLocationAtPixel(200, 200)).toBeNull();
    });
  });

  describe("getObjectInteractionPosition", () => {
    it("返回物件正下方一格的站位（不是几何中心）", () => {
      mm.loadFromTiledJSON(
        makeTiled({
          objects: [
            { objectId: "obj_tea", name: "茶壶", x: 64, y: 96, w: 32, h: 32 },
          ],
        }),
      );
      // x = obj.x + width/2 = 80
      // y = obj.y + height + tileSize = 96 + 32 + 32 = 160（站在物件下方）
      expect(mm.getObjectInteractionPosition("obj_tea")).toEqual({ x: 80, y: 160 });
    });

    it("交互位置与物件原位置不同", () => {
      mm.loadFromTiledJSON(
        makeTiled({
          objects: [
            { objectId: "obj_tea", name: "茶壶", x: 64, y: 96, w: 32, h: 32 },
          ],
        }),
      );
      const pos = mm.getObjectPosition("obj_tea")!;
      const inter = mm.getObjectInteractionPosition("obj_tea")!;
      expect(inter.y).toBeGreaterThan(pos.y);
      expect(inter.x).not.toBe(pos.x);
    });

    it("物件不存在时返回 null", () => {
      mm.loadFromTiledJSON(makeTiled());
      expect(mm.getObjectInteractionPosition("不存在")).toBeNull();
    });
  });

  describe("mainAreaPoints", () => {
    it("设置后可按 id 取回", () => {
      mm.loadFromTiledJSON(makeTiled());
      mm.setMainAreaPoints([
        { id: "p1", name: "茶桌", x: 100, y: 100 } as any,
      ]);
      expect(mm.getMainAreaPoint("p1")?.name).toBe("茶桌");
      expect(mm.getMainAreaPoints()).toHaveLength(1);
    });

    it("id 为 null 时返回 null", () => {
      mm.loadFromTiledJSON(makeTiled());
      expect(mm.getMainAreaPoint(null)).toBeNull();
      expect(mm.getMainAreaPoint(undefined)).toBeNull();
    });

    it("传入 undefined 会清空点位", () => {
      mm.loadFromTiledJSON(makeTiled());
      mm.setMainAreaPoints([{ id: "p1", name: "茶桌", x: 1, y: 1 } as any]);
      mm.setMainAreaPoints(undefined);
      expect(mm.getMainAreaPoints()).toHaveLength(0);
    });
  });

  describe("getVisibleLocations / getAllLocationIds", () => {
    it("列出全部区域 id", () => {
      mm.loadFromTiledJSON(
        makeTiled({
          regions: [
            { id: "alley", name: "巷口", x: 0, y: 0, w: 32, h: 32 },
            { id: "teahouse", name: "茶馆", x: 32, y: 0, w: 32, h: 32 },
          ],
        }),
      );
      expect(mm.getAllLocationIds().sort()).toEqual(["alley", "teahouse"]);
      expect(mm.getVisibleLocations()).toHaveLength(2);
    });
  });
});
