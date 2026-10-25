import { describe, it, expect } from "vitest";
import {
  DEFAULT_TILE_SIZE,
  parseTmj,
  toInteractiveObjects,
  toLocationRects,
  gridToPixel,
  pixelToGrid,
} from "./tmj-parser.js";

/**
 * TMJ 解析的测试。
 *
 * ## 为什么单独测
 *
 * `tmj-parser.ts` 是全仓**唯一**的 TMJ 解析实现 —— 改造前有四份
 * （client / core / orchestrator × 2），彼此之间只靠「文件名 + 层名」
 * 两个字符串约定，没有任何类型、没有任何校验。
 *
 * 收敛到一份之后，**所有调用方都依赖它的行为**。
 * 所以这里测的不只是「解析得对不对」，还有
 * 「哪些异常输入要怎么处理」—— 那些行为以前散在四份实现里，
 * 各不相同，且都没测过。
 *
 * 关键约定（见 tmj-parser.ts 的注释）：
 *
 * - 区域**没有 id 属性就跳过**（client 的老规则）
 * - 物件**没有 objectId 就跳过**
 * - TMJ 里**没有 collision 层** → `collisionGrid` 为 null
 *   （不是空数组 —— 空数组会被误当成「一张全阻挡的图」）
 */

describe("parseTmj", () => {
  describe("基本结构", () => {
    it("读出网格尺寸和格子边长", () => {
      const parsed = parseTmj({
        width: 100,
        height: 50,
        tilewidth: 32,
        layers: [],
      });
      expect(parsed.width).toBe(100);
      expect(parsed.height).toBe(50);
      expect(parsed.tileSize).toBe(32);
    });

    it("像素尺寸 = 格数 × 格子边长", () => {
      const parsed = parseTmj({
        width: 100,
        height: 50,
        tilewidth: 32,
        layers: [],
      });
      expect(parsed.pixelWidth).toBe(3200);
      expect(parsed.pixelHeight).toBe(1600);
    });

    it("没有 tilewidth 时用默认边长", () => {
      const parsed = parseTmj({ width: 10, height: 10, layers: [] });
      expect(parsed.tileSize).toBe(DEFAULT_TILE_SIZE);
      expect(DEFAULT_TILE_SIZE).toBe(32);
    });

    it("空输入不抛错", () => {
      const parsed = parseTmj(undefined);
      expect(parsed.width).toBe(0);
      expect(parsed.height).toBe(0);
      expect(parsed.collisionGrid).toBeNull();
      expect(parsed.regions).toEqual([]);
      expect(parsed.interactiveObjects).toEqual([]);
      expect(parsed.background).toBeNull();
    });

    it("layers 不是数组时不抛错", () => {
      const parsed = parseTmj({ width: 10, height: 10, layers: "不是数组" });
      expect(parsed.collisionGrid).toBeNull();
      expect(parsed.regions).toEqual([]);
    });
  });

  describe("collision 层", () => {
    it("0 = 可走，非 0 = 阻挡", () => {
      const parsed = parseTmj({
        width: 3,
        height: 2,
        tilewidth: 32,
        layers: [
          {
            type: "tilelayer",
            name: "collision",
            data: [0, 1, 0, 0, 0, 7],
          },
        ],
      });

      expect(parsed.collisionGrid).toEqual([
        [0, 1, 0],
        [0, 0, 1],
      ]);
    });

    it("没有 collision 层时是 null（不是空数组）", () => {
      const parsed = parseTmj({
        width: 3,
        height: 2,
        layers: [{ type: "tilelayer", name: "别的层", data: [0, 0, 0, 0, 0, 0] }],
      });
      // 空数组会被误当成「一张全阻挡的图」—— 必须是 null
      expect(parsed.collisionGrid).toBeNull();
      expect(parsed.collisionData).toBeNull();
    });

    it("collision 层名不对时不生效", () => {
      const parsed = parseTmj({
        width: 2,
        height: 1,
        layers: [
          { type: "tilelayer", name: "collisions", data: [1, 1] },
        ],
      });
      expect(parsed.collisionGrid).toBeNull();
    });

    it("collision 层类型不是 tilelayer 时不生效", () => {
      const parsed = parseTmj({
        width: 2,
        height: 1,
        layers: [
          { type: "objectgroup", name: "collision", objects: [] },
        ],
      });
      expect(parsed.collisionGrid).toBeNull();
    });

    it("保留原始扁平数组（core 的点位邻接算法要这个形状）", () => {
      const data = [0, 1, 0, 0];
      const parsed = parseTmj({
        width: 2,
        height: 2,
        layers: [{ type: "tilelayer", name: "collision", data }],
      });
      expect(parsed.collisionData).toEqual(data);
    });
  });

  describe("regions 层", () => {
    it("读出区域并摊平 properties", () => {
      const parsed = parseTmj({
        width: 10,
        height: 10,
        layers: [
          {
            type: "objectgroup",
            name: "regions",
            objects: [
              {
                name: "镇心集市",
                x: 32,
                y: 64,
                width: 96,
                height: 128,
                properties: [
                  { name: "id", value: "town_market_square" },
                  { name: "description", value: "早集与摊贩汇聚的空地" },
                  { name: "regionType", value: "outdoor" },
                ],
              },
            ],
          },
        ],
      });

      expect(parsed.regions).toHaveLength(1);
      const region = parsed.regions[0];
      expect(region.id).toBe("town_market_square");
      expect(region.name).toBe("镇心集市");
      expect(region.x).toBe(32);
      expect(region.y).toBe(64);
      expect(region.width).toBe(96);
      expect(region.height).toBe(128);
      expect(region.properties.description).toBe("早集与摊贩汇聚的空地");
      expect(region.properties.regionType).toBe("outdoor");
    });

    it("没有 id 的区域：id 为 null（**不退回用 name**）", () => {
      const parsed = parseTmj({
        width: 10,
        height: 10,
        layers: [
          {
            type: "objectgroup",
            name: "regions",
            objects: [
              { name: "没有 id 的区域", x: 0, y: 0, width: 32, height: 32, properties: [] },
            ],
          },
        ],
      });

      expect(parsed.regions).toHaveLength(1);
      expect(parsed.regions[0].id).toBeNull();
      expect(parsed.regions[0].name).toBe("没有 id 的区域");

      // 转成矩形时**跳过**它
      expect(toLocationRects(parsed.regions)).toEqual([]);
    });

    it("id 是空字符串时当作没有 id", () => {
      const parsed = parseTmj({
        width: 10,
        height: 10,
        layers: [
          {
            type: "objectgroup",
            name: "regions",
            objects: [
              { name: "空 id", x: 0, y: 0, width: 32, height: 32, properties: [{ name: "id", value: "" }] },
            ],
          },
        ],
      });
      expect(parsed.regions[0].id).toBeNull();
    });

    it("properties 里的重复属性名后者覆盖前者", () => {
      const parsed = parseTmj({
        width: 10,
        height: 10,
        layers: [
          {
            type: "objectgroup",
            name: "regions",
            objects: [
              {
                name: "重复属性",
                x: 0,
                y: 0,
                width: 32,
                height: 32,
                properties: [
                  { name: "id", value: "first" },
                  { name: "id", value: "second" },
                ],
              },
            ],
          },
        ],
      });
      expect(parsed.regions[0].id).toBe("second");
    });

    it("layers 层名对不上时不生效", () => {
      const parsed = parseTmj({
        width: 10,
        height: 10,
        layers: [
          {
            type: "objectgroup",
            name: "location",
            objects: [
              { name: "x", x: 0, y: 0, width: 32, height: 32, properties: [{ name: "id", value: "a" }] },
            ],
          },
        ],
      });
      expect(parsed.regions).toEqual([]);
    });
  });

  describe("interactive_objects 层", () => {
    it("读出物件并摊平 properties", () => {
      const parsed = parseTmj({
        width: 10,
        height: 10,
        layers: [
          {
            type: "objectgroup",
            name: "interactive_objects",
            objects: [
              {
                name: "茶壶",
                x: 64,
                y: 96,
                width: 32,
                height: 32,
                properties: [{ name: "objectId", value: "obj_tea" }],
              },
            ],
          },
        ],
      });

      expect(parsed.interactiveObjects).toHaveLength(1);
      expect(parsed.interactiveObjects[0].objectId).toBe("obj_tea");
      expect(parsed.interactiveObjects[0].name).toBe("茶壶");
    });

    it("没有 objectId 的物件：objectId 为 null，转矩形时跳过", () => {
      const parsed = parseTmj({
        width: 10,
        height: 10,
        layers: [
          {
            type: "objectgroup",
            name: "interactive_objects",
            objects: [
              { name: "没有 objectId", x: 0, y: 0, width: 32, height: 32, properties: [] },
            ],
          },
        ],
      });

      expect(parsed.interactiveObjects).toHaveLength(1);
      expect(parsed.interactiveObjects[0].objectId).toBeNull();
      expect(toInteractiveObjects(parsed.interactiveObjects)).toEqual([]);
    });

    it("区域层里的 id 不会串到物件层", () => {
      // 物件层的对象即使有 id 属性，也不该被当成 objectId
      const parsed = parseTmj({
        width: 10,
        height: 10,
        layers: [
          {
            type: "objectgroup",
            name: "interactive_objects",
            objects: [
              { name: "x", x: 0, y: 0, width: 32, height: 32, properties: [{ name: "id", value: "some_id" }] },
            ],
          },
        ],
      });
      expect(parsed.interactiveObjects[0].objectId).toBeNull();
      expect(parsed.interactiveObjects[0].id).toBeNull();
    });
  });

  describe("background 层", () => {
    it("读出背景图与它的像素尺寸", () => {
      const parsed = parseTmj({
        width: 100,
        height: 50,
        tilewidth: 32,
        layers: [
          {
            type: "imagelayer",
            name: "background",
            image: "06-background.png",
            imagewidth: 3200,
            imageheight: 1600,
          },
        ],
      });
      expect(parsed.background).toEqual({
        image: "06-background.png",
        width: 3200,
        height: 1600,
      });
    });

    it("没有 background 层时是 null", () => {
      const parsed = parseTmj({ width: 10, height: 10, layers: [] });
      expect(parsed.background).toBeNull();
    });
  });

  describe("坐标换算", () => {
    it("像素 → 网格：向下取整", () => {
      expect(pixelToGrid(0, 0, 32)).toEqual({ gx: 0, gy: 0 });
      expect(pixelToGrid(31, 31, 32)).toEqual({ gx: 0, gy: 0 });
      expect(pixelToGrid(32, 32, 32)).toEqual({ gx: 1, gy: 1 });
      expect(pixelToGrid(63, 95, 32)).toEqual({ gx: 1, gy: 2 });
    });

    it("网格 → 像素：格子中心", () => {
      expect(gridToPixel(0, 0, 32)).toEqual({ x: 16, y: 16 });
      expect(gridToPixel(1, 1, 32)).toEqual({ x: 48, y: 48 });
      expect(gridToPixel(2, 3, 16)).toEqual({ x: 40, y: 56 });
    });

    it("往返换算：像素中心 → 网格 → 像素中心，回到原点", () => {
      for (const [gx, gy] of [[0, 0], [3, 7], [19, 24]]) {
        const p = gridToPixel(gx, gy, 32);
        const g = pixelToGrid(p.x, p.y, 32);
        expect(g).toEqual({ gx, gy });
      }
    });
  });
});
