/**
 * 改造前 vs 改造后 的 A/B 对比。
 *
 * ## 为什么是这个文件
 *
 * 阶段 5 把 `MapManager` / `PathfindingManager` 从 client 搬到了
 * `packages/client-core`，并把 TMJ 解析收敛到 `tmj-parser.ts`。
 *
 * 搬家本身不该改变任何行为 —— 但「不该」不是「确实」。
 * 寻路的输出**逐点**决定角色怎么走：路径差一格，角色就撞墙或绕远。
 * 而改造前 `PathfindingManager` **一条测试都没有**（这是阶段 5 之前
 * 全仓唯一零测试的核心类）。
 *
 * 所以这里不是「新实现的自我验证」——**基准是改造前的字面实现**，
 * 从 git 历史里按原样取出来（见 `testing/legacy-baseline.ts`）。
 * 新实现跟它逐点比，差一个点就是回归。
 *
 * ## 基准从哪来
 *
 * 原来基准是仓库里的一份代码副本（`.legacy-baseline/`）。
 * 那种做法有个坏处：**仓库里多一份重复代码** ——
 * 改 `MapManager` 的人得记得基准也要改，忘了 A/B 就变成自证清白。
 *
 * 现在基准从 git 提取，**没人能顺手改它**。
 * 拿不到基准时（浅克隆、没有 .git）**跳过，不红** ——
 * 基准是辅助验证，不是产品逻辑。
 *
 * ## 这个文件不进包
 *
 * 基准在 `node_modules/.cache/` 下，测试跑的时候现提取现用。
 * 它不进 `npm run build:client-core` 的产物。
 */

import { describe, it, expect } from "vitest";
import { loadLegacyBaseline } from "./testing/legacy-baseline.js";
import { MapManager } from "./map-model.js";
import { PathfindingManager } from "./pathfinding.js";

/**
 * 造一个 Tiled JSON。
 *
 * 跟 map-model.test.ts 的 helper 一样，但参数化了 tilewidth ——
 * 真实世界的地图 tilewidth 不都是 32。
 */
function makeTiled(opts: {
  width: number;
  height: number;
  tilewidth?: number;
  collision: number[];
  regions?: { id: string; name: string; x: number; y: number; w: number; h: number }[];
  objects?: { objectId: string; name: string; x: number; y: number; w: number; h: number }[];
}) {
  const tilewidth = opts.tilewidth ?? 32;
  return {
    width: opts.width,
    height: opts.height,
    tilewidth,
    layers: [
      { type: "tilelayer", name: "collision", data: opts.collision },
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

/** 一堆格子全可走的地图 */
function openMap(w: number, h: number, tilewidth = 32) {
  return makeTiled({
    width: w,
    height: h,
    tilewidth,
    collision: new Array(w * h).fill(0),
  });
}

/**
 * 造一张「有结构」的地图：随机但**确定性**的碰撞。
 *
 * 用固定种子的线性同余，而不是 Math.random()——
 * 测试必须每次跑出一样的地图，否则失败时无法复现。
 */
function structuredMap(w: number, h: number, seed: number, density: number) {
  const collision = new Array(w * h);
  let state = seed;
  for (let i = 0; i < w * h; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    collision[i] = state / 0x7fffffff < density ? 1 : 0;
  }
  return makeTiled({ width: w, height: h, collision });
}

/** 格子中心像素 */
function center(gx: number, gy: number, tile = 32) {
  return { x: gx * tile + tile / 2, y: gy * tile + tile / 2 };
}

/**
 * 对同一份 TMJ 同时跑两套实现，比对解析结果。
 */
function compareParsing(
  tmj: ReturnType<typeof makeTiled>,
  LegacyMapManager: new () => any,
) {
  const legacy = new LegacyMapManager();
  const modern = new MapManager();
  legacy.loadFromTiledJSON(tmj as any);
  modern.loadFromTiledJSON(tmj as any);

  // 网格尺寸
  expect(modern.gridWidth).toBe(legacy.gridWidth);
  expect(modern.gridHeight).toBe(legacy.gridHeight);
  expect(modern.tileSize).toBe(legacy.tileSize);

  // 碰撞网格逐格相等
  expect(modern.collisionGrid).toEqual(legacy.collisionGrid);

  // 区域 —— id 集合与每个区域的矩形都要一样
  expect([...modern.locations.keys()].sort()).toEqual([...legacy.locations.keys()].sort());
  for (const [id, loc] of legacy.locations) {
    expect(modern.locations.get(id)).toEqual(loc);
  }

  // 物件
  expect([...modern.interactiveObjects.keys()].sort()).toEqual(
    [...legacy.interactiveObjects.keys()].sort(),
  );
  for (const [id, obj] of legacy.interactiveObjects) {
    expect(modern.interactiveObjects.get(id)).toEqual(obj);
  }
}

/**
 * 对同一份 TMJ 同时跑两套实现，比对寻路结果。
 */
async function comparePath(
  tmj: ReturnType<typeof makeTiled>,
  from: { gx: number; gy: number },
  to: { gx: number; gy: number },
  legacy: { MapManager: new () => any; PathfindingManager: new (map: any) => any },
  tile = 32,
) {
  const legacyMap = new legacy.MapManager();
  const modernMap = new MapManager();
  legacyMap.loadFromTiledJSON(tmj as any);
  modernMap.loadFromTiledJSON(tmj as any);

  const legacyPf = new legacy.PathfindingManager(legacyMap);
  const modernPf = new PathfindingManager(modernMap);

  const f = center(from.gx, from.gy, tile);
  const t = center(to.gx, to.gy, tile);

  const legacyPath = await legacyPf.findPath(f.x, f.y, t.x, t.y);
  const modernPath = await modernPf.findPath(f.x, f.y, t.x, t.y);

  // **逐点相等** —— 不是「差不多」，是完全一样
  expect(modernPath).toEqual(legacyPath);
  return { legacyPath, modernPath };
}

/**
 * 基准 —— 从 git 历史提取的改造前实现。
 *
 * 拿不到（浅克隆 / 没有 .git）就**跳过整组测试**，不红。
 * 基准是辅助验证，不是产品逻辑 —— 拿不到它说明「这次没做这项验证」，
 * 而不是「产品坏了」。
 *
 * ## 为什么是顶层 await，不是 beforeAll
 *
 * `it.skipIf(条件)` 的条件在**收集阶段**求值 —— 也就是 vitest 收集
 * 测试用例的时候。那会儿 `beforeAll` 还没跑，`baseline` 还是 null，
 * 于是**全部**用例都会被跳过。
 *
 * 顶层 await 在收集之前就完成加载，条件才拿得到真值。
 */
const loaded = await loadLegacyBaseline();
const baseline: {
  MapManager: new () => any;
  PathfindingManager: new (map: any) => any;
} | null = loaded.ok
  ? { MapManager: loaded.MapManager, PathfindingManager: loaded.PathfindingManager }
  : null;

// 基准拿不到时把原因打出来 —— 否则「跳过了 15 条」会让人以为测试没跑。
if (!baseline) {
  console.warn(
    `[A/B 对比] 跳过 —— 拿不到改造前基准：${loaded.reason}\n` +
      `  这不是失败，是「这次没做 A/B 验证」。CI 里靠 fetch-depth: 0 拿到基准。`,
  );
}

/**
 * 基准不可用时跳过。
 *
 * `it.skipIf` 收的是**布尔值**，不是返回布尔值的函数 ——
 * 传函数的话那个函数本身是真值，于是**全部**用例都被跳过
 * （而且不报错，很难发现）。
 *
 * 基准在顶层 await 里已经解析完了，所以这里直接给布尔值。
 */
const itWithBaseline = it.skipIf(baseline === null);

describe("改造前 vs 改造后：解析结果一致", () => {
  itWithBaseline("空地图", () => {
    compareParsing(openMap(10, 10), baseline!.MapManager);
  });

  itWithBaseline("有区域和物件的地图", () => {
    compareParsing(
      makeTiled({
        width: 12,
        height: 12,
        collision: new Array(144).fill(0),
        regions: [
          { id: "alley", name: "巷口", x: 0, y: 0, w: 96, h: 96 },
          { id: "square", name: "集市", x: 128, y: 64, w: 160, h: 160 },
        ],
        objects: [
          { objectId: "obj_tea", name: "茶壶", x: 64, y: 96, w: 32, h: 32 },
          { objectId: "obj_stall", name: "摊子", x: 160, y: 96, w: 32, h: 32 },
        ],
      }),
      baseline!.MapManager,
    );
  });

  itWithBaseline("区域缺 id 时两边都跳过", () => {
    const tmj = makeTiled({
      width: 10,
      height: 10,
      collision: new Array(100).fill(0),
    });
    // 手插一个没有 id 属性的区域
    (tmj.layers[1].objects as any[]).push({
      name: "没有 id 的区域",
      x: 0,
      y: 0,
      width: 32,
      height: 32,
      properties: [],
    });
    compareParsing(tmj, baseline!.MapManager);
  });

  itWithBaseline("物件缺 objectId 时两边都跳过", () => {
    const tmj = makeTiled({
      width: 10,
      height: 10,
      collision: new Array(100).fill(0),
    });
    (tmj.layers[2].objects as any[]).push({
      name: "没有 objectId 的物件",
      x: 0,
      y: 0,
      width: 32,
      height: 32,
      properties: [],
    });
    compareParsing(tmj, baseline!.MapManager);
  });

  itWithBaseline("tilewidth 不是 32 时也一致", () => {
    compareParsing(openMap(8, 8, 16), baseline!.MapManager);
  });
});

describe("改造前 vs 改造后：寻路结果逐点一致", () => {
  itWithBaseline("空地直路", async () => {
    await comparePath(openMap(10, 10), { gx: 0, gy: 0 }, { gx: 5, gy: 0 }, baseline!);
  });

  itWithBaseline("空地斜线", async () => {
    await comparePath(openMap(10, 10), { gx: 0, gy: 0 }, { gx: 7, gy: 4 }, baseline!);
  });

  itWithBaseline("起点即终点", async () => {
    await comparePath(openMap(10, 10), { gx: 3, gy: 3 }, { gx: 3, gy: 3 }, baseline!);
  });

  itWithBaseline("终点被阻挡（挪到最近可走格）", async () => {
    const collision = new Array(100).fill(0);
    collision[5 * 10 + 5] = 1;
    const tmj = makeTiled({ width: 10, height: 10, collision });
    await comparePath(tmj, { gx: 0, gy: 0 }, { gx: 5, gy: 5 }, baseline!);
  });

  itWithBaseline("起点被完全封死", async () => {
    const collision = new Array(100).fill(0);
    collision[0] = 1;
    collision[1] = 1;
    collision[10] = 1;
    const tmj = makeTiled({ width: 10, height: 10, collision });
    await comparePath(tmj, { gx: 0, gy: 0 }, { gx: 5, gy: 5 }, baseline!);
  });

  itWithBaseline("有墙的地图（绕行）", async () => {
    const collision = new Array(100).fill(0);
    for (let y = 0; y < 10; y++) {
      if (y === 5) continue;
      collision[y * 10 + 5] = 1;
    }
    const tmj = makeTiled({ width: 10, height: 10, collision });
    await comparePath(tmj, { gx: 1, gy: 1 }, { gx: 9, gy: 8 }, baseline!);
  });

  itWithBaseline("宽斜通道（触发楼梯重塑）", async () => {
    // 3 格宽的对角通道 —— 让 reshapeStaircaseRun 有发挥空间
    const w = 20;
    const h = 20;
    const collision = new Array(w * h).fill(1);
    for (let i = 0; i < 15; i++) {
      collision[i * w + i] = 0;
      collision[i * w + i + 1] = 0;
      collision[i * w + i + 2] = 0;
    }
    const tmj = makeTiled({ width: w, height: h, collision });
    await comparePath(tmj, { gx: 0, gy: 0 }, { gx: 13, gy: 13 }, baseline!);
  });

  itWithBaseline("窄斜通道", async () => {
    const w = 20;
    const h = 20;
    const collision = new Array(w * h).fill(1);
    for (let i = 0; i < 15; i++) {
      collision[i * w + i] = 0;
      collision[i * w + i + 1] = 0;
    }
    const tmj = makeTiled({ width: w, height: h, collision });
    await comparePath(tmj, { gx: 0, gy: 0 }, { gx: 13, gy: 13 }, baseline!);
  });

  itWithBaseline("密集障碍的地图（多种子）", async () => {
    // 多种子覆盖不同的绕行形态 ——
    // 单一种子可能碰巧不触发某条代码路径。
    for (const seed of [1, 7, 42, 1234, 99991]) {
      const tmj = structuredMap(24, 24, seed, 0.25);
      await comparePath(tmj, { gx: 0, gy: 0 }, { gx: 20, gy: 20 }, baseline!);
      await comparePath(tmj, { gx: 2, gy: 3 }, { gx: 18, gy: 5 }, baseline!);
    }
  });

  itWithBaseline("密集障碍 + tilewidth 16", async () => {
    const tmj = structuredMap(20, 20, 555, 0.3);
    await comparePath(tmj, { gx: 0, gy: 0 }, { gx: 17, gy: 15 }, baseline!, 16);
  });
});
