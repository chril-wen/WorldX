/**
 * 改造前 vs 改造后：场景坐标**逐点相等**。
 *
 * ## 这个文件在防什么
 *
 * 阶段 8.1 把「位置计算」从 Phaser 场景搬进 `packages/client-core`。
 * 搬家的失败模式很隐蔽：**画面看着差不多，但差半个像素**。
 *
 * 名牌挂在头顶、气泡挂在头顶上方、区域名贴在框的上方、
 * 悬停标签居中于物件 —— 这些都是「差一点点就歪」的位置。
 * 而位置歪了的代价是：角色和名牌对不上、标签飘在地图外面、
 * 有人被别的角色挡住。
 *
 * 所以这里的验收标准不是「差不多」，是**逐点相等**。
 *
 * ## 基准是真·改造前的实现
 *
 * 基准**从 git 历史提取**（`testing/legacy-scene-baseline.ts`）——
 * 是 commit `29a5eee` 里的**字面实现**，
 * 不是「新实现跑一遍跟自己比」。
 *
 * 提取出来的文件里 `import Phaser from "phaser"` 被改写成
 * **测试替身**（`testing/phaser-stub.ts`）——
 * 替身只把「画到 GPU」换成「记到数组」，
 * **位置算术一个字都没改**。
 *
 * 被检验的那段逻辑因此是逐字的老代码。
 *
 * ## 为什么地图数据层指向现在的 client-core
 *
 * 改造前的 `client/src/systems/MapManager.ts` **已经**是
 * `@own-world/client-core` 的门面了（阶段 5 搬完的）——
 * 它自己就只有一行 re-export。
 *
 * 这不是「用新实现给自己当基准」：
 * 阶段 5 的 A/B 对比（`ab-comparison.test.ts`）已经证明
 * 「现在的 client-core」跟「阶段 5 之前的 client MapManager」逐点相等。
 *
 * 8.1 关心的是**渲染层**的位置逻辑，不是地图数据层。
 *
 * ## 拿不到基准怎么办
 *
 * **跳过，不红。** 基准是辅助验证：拿不到它说明「这次没做这项验证」，
 * 不是「产品坏了」。
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { loadLegacySceneBaseline } from "../testing/legacy-scene-baseline.js";
import { MapManager } from "../map-model.js";
import {
  buildRenderScene,
  getBubbleAnchorOffsetY,
  getHeadWorldOffset,
  resolveCharacterPlacements,
  type CharacterRenderState,
} from "./scene-builder.js";
import { createCharacterDisplayMetrics } from "./character-metrics.js";
import type { CameraState, DrawItem, DrawText } from "./render-model.js";

/* ── 基准加载 ──────────────────────────────────────────────────── */

/**
 * 基准 —— 从 git 历史提取的改造前实现。
 *
 * 拿不到（浅克隆 / 没有 .git）就**跳过整组测试**，不红。
 *
 * ## 为什么是顶层 await，不是 beforeAll
 *
 * `it.skipIf(条件)` 的条件在**收集阶段**求值 —— 那会儿 `beforeAll`
 * 还没跑，基准还是 null，于是**全部**用例都会被跳过。
 *
 * 顶层 await 在收集之前就完成加载，条件才拿得到真值。
 */
const loaded = await loadLegacySceneBaseline();
const baseline = loaded.ok ? loaded : null;

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
 */
const itWithBaseline = it.skipIf(baseline === null);

/* ── 替身环境 ──────────────────────────────────────────────────── */

/**
 * Phaser 替身里的最小 DOM —— 旧代码的名牌是 `HTMLDivElement`，
 * 它自己建元素、自己写 `style.left` / `style.top`。
 */
const dom = installDom();

/** 装一个最小 `document` 全局，返回元素仓库。 */
function installDom() {
  const elements = new Map<string, any>();
  for (const id of ["label-root", "ui-root"]) elements.set(id, makeElement());

  const previous = (globalThis as any).document;
  (globalThis as any).document = {
    getElementById: (id: string) => elements.get(id) ?? null,
    createElement: () => makeElement(),
    body: makeElement(),
  };
  return { elements, restore: () => {
    if (previous === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = previous;
  } };
}

/** 一个只记 style 的假元素。 */
function makeElement(): any {
  return {
    style: {} as Record<string, string>,
    className: "",
    textContent: "",
    children: [] as any[],
    appendChild(child: any) { this.children.push(child); return child; },
    append(...c: any[]) { this.children.push(...c); },
    remove() {},
  };
}

afterAll(() => {
  dom.restore();
});

/* ── 测试用的地图 ──────────────────────────────────────────────── */

function makeTiled(opts: {
  width?: number;
  height?: number;
  tilewidth?: number;
  collision?: number[];
  regions?: { id: string; name: string; x: number; y: number; w: number; h: number }[];
  objects?: { objectId: string; name: string; x: number; y: number; w: number; h: number }[];
} = {}) {
  const width = opts.width ?? 20;
  const height = opts.height ?? 20;
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

/** 一张有区域、有物件、有墙的地图。 */
function makeMapJson() {
  const collision = new Array(400).fill(0);
  for (let x = 0; x < 20; x++) collision[10 * 20 + x] = 1;
  return makeTiled({
    collision,
    regions: [
      { id: "alley", name: "巷口", x: 32, y: 32, w: 128, h: 96 },
      { id: "square", name: "集市", x: 192, y: 128, w: 160, h: 160 },
    ],
    objects: [
      { objectId: "obj_tea", name: "茶壶", x: 64, y: 96, w: 32, h: 32 },
      { objectId: "obj_stall", name: "摊子", x: 160, y: 96, w: 48, h: 32 },
    ],
  });
}

/* ── 文字测量 ──────────────────────────────────────────────────── */

/**
 * 一个**模仿 Phaser** 的文字测量。
 *
 * Phaser 的 `GetTextSize`：
 *
 * ```
 * 宽 = ceil(文字宽 + 描边粗细)
 * 高 = 字号 + 描边粗细
 * ```
 *
 * 注意**高度是字号**，不是字体量出来的行高 ——
 * Phaser 用的是 `size.fontSize + style.strokeThickness`。
 *
 * 宽度这里用「每字 10px」这种确定性的算法 ——
 * 测试要能复现，不能靠真实字体。
 */
function measureText(text: string, font: string) {
  const size = /(\d+(?:\.\d+)?)px/.exec(font);
  const fontSize = size ? Number(size[1]) : 16;
  return { width: text.length * 10, height: fontSize };
}

/**
 * 把**同一个**测量函数装进 Phaser 替身。
 *
 * ## 为什么必须这样
 *
 * A/B 比的是「两边量出来的尺寸」。
 * 替件自带一套默认测量（每字 8px、行高 16），
 * builder 用的是上面那个（每字 10px、行高=字号）。
 *
 * 两套测量 → 尺寸必然不等 → 差异会被误读成「位置逻辑不一样」。
 * **测量的差异不是被检验的那段逻辑**，必须先消掉。
 */
baseline?.setStubTextMeasurer(measureText);

/* ── 确定性随机数 ──────────────────────────────────────────────── */

/**
 * 固定 `Math.random`，让**每一次调用**都返回同一个序列。
 *
 * ## 为什么站位测试需要它
 *
 * 非中心区域的站位走 `getRandomWalkablePointInLocation()`，
 * 里面是 `Math.floor(Math.random() * pool.length)`。
 *
 * 旧实现和新实现**各调一次** —— 就算两边用的是同一份代码，
 * 也会拿到**两个不同的随机数** → 两个不同的站位。
 *
 * 这不是「位置逻辑不一样」，是「随机」本身。
 * 固定住随机数，两边才会抽到**同一个**候选。
 *
 * 手法跟 `scripts/rules-ab.mjs` 的 `installDeterministicClock` 一致
 * （xorshift32）—— 那套已经在阶段 2.5 验证过。
 */
function withSeededRandom<T>(fn: () => T): T {
  const original = Math.random;
  let s = 20261030 >>> 0;
  Math.random = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
  try {
    return fn();
  } finally {
    Math.random = original;
  }
}

/* ── 相机 ──────────────────────────────────────────────────────── */

/**
 * 一台**改造前的**相机参数。
 *
 * 老实现里屏幕坐标是这么算的：
 *
 * ```
 * screenX = (worldX - worldView.x) * zoom + camera.x
 * ```
 *
 * 其中 `worldView.x` 是 Phaser 算出来的（**带取整**）。
 *
 * 契约里用的是 `scrollX`（**不带取整**）——
 * 这个差别是**刻意的**（见 `render-model.ts` 的说明），
 * 不是被搬的逻辑的一部分。
 *
 * 所以 A/B 时我们**把老相机的 `worldView.x` 直接喂给 builder 的 `scrollX`** ——
 * 这样比的就是「被搬的那段逻辑」，不是「相机的取整」。
 */
const LEGACY_CAMERA = {
  width: 800,
  height: 600,
  zoom: 0.75,
  scrollX: 1234,
  scrollY: 567,
};

/** 老相机的 `worldView` —— 照抄 Phaser 的取整公式。 */
function legacyWorldView(cam = LEGACY_CAMERA) {
  const halfWidth = cam.width * 0.5;
  const halfHeight = cam.height * 0.5;
  const midX = cam.scrollX + halfWidth;
  const midY = cam.scrollY + halfHeight;
  const displayWidth = Math.floor(cam.width / cam.zoom + 0.5);
  const displayHeight = Math.floor(cam.height / cam.zoom + 0.5);
  return {
    x: Math.floor(midX - displayWidth / 2 + 0.5),
    y: Math.floor(midY - displayHeight / 2 + 0.5),
    width: displayWidth,
    height: displayHeight,
  };
}

/** 契约里的相机 —— `scrollX` 喂老相机的 `worldView`。 */
function makeContractCamera(cam = LEGACY_CAMERA): CameraState {
  const wv = legacyWorldView(cam);
  return {
    scrollX: wv.x,
    scrollY: wv.y,
    zoom: cam.zoom,
    viewportX: 0,
    viewportY: 0,
    viewportWidth: wv.width,
    viewportHeight: wv.height,
    mapWidth: 640,
    mapHeight: 640,
  };
}

/* ── 跑老代码 ──────────────────────────────────────────────────── */

/**
 * 造一个**改造前的** `WorldScene` 实例。
 *
 * 只填 `build*Overlay()` 这几个方法要用的字段：
 *
 * - `mapManager` —— 地图数据层
 * - `cameras.main` —— 相机
 * - `characterSprites` —— 空的 `Map`（老代码遍历它同步缩放）
 *
 * **不调 `create()`** —— `create()` 会去拉网络、读 `cache.json`、
 * 跑一整套 Phaser 场景生命周期。那些不是被检验的部分。
 */
function makeLegacyScene(map: any) {
  const scene = new baseline!.WorldScene();
  scene.mapManager = map;
  scene.cameras.main.zoom = LEGACY_CAMERA.zoom;
  scene.cameras.main.width = LEGACY_CAMERA.width;
  scene.cameras.main.height = LEGACY_CAMERA.height;
  scene.cameras.main.scrollX = LEGACY_CAMERA.scrollX;
  scene.cameras.main.scrollY = LEGACY_CAMERA.scrollY;
  scene.cameras.main.preRender();
  return scene;
}

/** 从老场景的 graphics 里挑出某类操作。 */
function opsOf(graphics: any, op: string) {
  return graphics.ops.filter((o: any) => o.op === op);
}

/* ── 对比工具 ──────────────────────────────────────────────────── */

/**
 * 逐点比较两组坐标。
 *
 * 差一个点就是回归 —— 所以**不用 `toBeCloseTo`**，
 * 用精确相等（`toEqual` / `toBe`）。
 */
function expectSamePoints(
  actual: Array<{ x: number; y: number }>,
  expected: Array<{ x: number; y: number }>,
  label: string,
) {
  expect(actual.length, `${label}: 图元数量`).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(actual[i].x, `${label}[${i}].x`).toBe(expected[i].x);
    expect(actual[i].y, `${label}[${i}].y`).toBe(expected[i].y);
  }
}

/* ── 测试 ──────────────────────────────────────────────────────── */

describe("改造前 vs 改造后：位置逐点一致", () => {
  let map: MapManager;

  beforeEach(() => {
    map = new MapManager();
    map.loadFromTiledJSON(makeMapJson() as any);
  });

  /* ── 可行走区域覆盖层 ── */

  itWithBaseline("可行走区域覆盖层：矩形逐点一致", () => {
    const legacyScene = makeLegacyScene(map);
    const legacyGraphics = legacyScene.buildWalkableOverlay();

    const scene = buildRenderScene({
      map,
      camera: makeContractCamera(),
      background: { source: "world-base", width: 640, height: 640 },
      characters: [],
      overlays: { walkable: true },
      measureText,
    });

    const layer = scene.layers.find((l) => l.id === "walkable-overlay")!;
    const fills = layer.items.filter((i) => i.kind === "rect" && i.fill);
    const strokes = layer.items.filter((i) => i.kind === "rect" && i.stroke);

    const legacyFills = opsOf(legacyGraphics, "fillRect");
    const legacyStrokes = opsOf(legacyGraphics, "strokeRect");

    expect(fills.length).toBe(legacyFills.length);
    expect(strokes.length).toBe(legacyStrokes.length);

    for (let i = 0; i < legacyFills.length; i++) {
      const legacy = legacyFills[i].args as number[];
      const modern = fills[i] as { x: number; y: number; width: number; height: number };
      expect(modern.x).toBe(legacy[0]);
      expect(modern.y).toBe(legacy[1]);
      expect(modern.width).toBe(legacy[2]);
      expect(modern.height).toBe(legacy[3]);
    }

    for (let i = 0; i < legacyStrokes.length; i++) {
      const legacy = legacyStrokes[i].args as number[];
      const modern = strokes[i] as { x: number; y: number; width: number; height: number };
      expect(modern.x).toBe(legacy[0]);
      expect(modern.y).toBe(legacy[1]);
      expect(modern.width).toBe(legacy[2]);
      expect(modern.height).toBe(legacy[3]);
    }
  });

  itWithBaseline("可行走区域覆盖层：颜色逐点一致", () => {
    const legacyScene = makeLegacyScene(map);
    const legacyGraphics = legacyScene.buildWalkableOverlay();

    const scene = buildRenderScene({
      map,
      camera: makeContractCamera(),
      background: { source: "world-base", width: 640, height: 640 },
      characters: [],
      overlays: { walkable: true },
      measureText,
    });

    const layer = scene.layers.find((l) => l.id === "walkable-overlay")!;
    const fills = layer.items.filter((i) => i.kind === "rect" && i.fill);
    const legacyFills = opsOf(legacyGraphics, "fillRect");

    for (let i = 0; i < legacyFills.length; i++) {
      const legacyFill = legacyFills[i].fill!;
      const modern = fills[i] as { fill: string; alpha?: number };
      expect(modern.fill).toBe(`#${legacyFill.color.toString(16).padStart(6, "0")}`);
      expect(modern.alpha).toBe(legacyFill.alpha);
    }
  });

  /* ── 区域框 + 区域名 ── */

  itWithBaseline("区域框：矩形逐点一致", () => {
    const legacyScene = makeLegacyScene(map);
    const legacyContainer = legacyScene.buildRegionBoundsOverlay();
    const legacyGraphics = legacyContainer.children[0];

    const scene = buildRenderScene({
      map,
      camera: makeContractCamera(),
      background: { source: "world-base", width: 640, height: 640 },
      characters: [],
      overlays: { regionBounds: true },
      measureText,
    });

    const layer = scene.layers.find((l) => l.id === "region-bounds")!;
    const fills = layer.items.filter((i) => i.kind === "rect" && i.fill);
    const legacyFills = opsOf(legacyGraphics, "fillRect");

    expect(fills.length).toBe(legacyFills.length);
    for (let i = 0; i < legacyFills.length; i++) {
      const legacy = legacyFills[i].args as number[];
      const modern = fills[i] as { x: number; y: number; width: number; height: number };
      expect(modern.x).toBe(legacy[0]);
      expect(modern.y).toBe(legacy[1]);
      expect(modern.width).toBe(legacy[2]);
      expect(modern.height).toBe(legacy[3]);
    }
  });

  itWithBaseline("区域名：位置、内容、尺寸逐点一致", () => {
    const legacyScene = makeLegacyScene(map);
    const legacyContainer = legacyScene.buildRegionBoundsOverlay();
    // 容器里：第一个是 graphics，后面是各个区域的 Text
    const legacyTexts = legacyContainer.children.slice(1) as any[];

    const scene = buildRenderScene({
      map,
      camera: makeContractCamera(),
      background: { source: "world-base", width: 640, height: 640 },
      characters: [],
      overlays: { regionBounds: true },
      measureText,
    });

    const layer = scene.layers.find((l) => l.id === "labels")!;
    const modernLabels = layer.items as DrawText[];

    expect(modernLabels.length).toBe(legacyTexts.length);

    for (let i = 0; i < legacyTexts.length; i++) {
      const legacy = legacyTexts[i];
      const modern = modernLabels[i];

      // 位置
      expect(modern.x).toBe(legacy.x);
      expect(modern.y).toBe(legacy.y);
      // 内容
      expect(modern.content).toBe(legacy.content);
      // 尺寸（含内边距 —— Phaser 的 Text.width 就是「文字盒 + 内边距」）
      expect(modern.width).toBe(legacy.width);
      expect(modern.height).toBe(legacy.height);
      // 颜色
      expect(modern.color).toBe(legacy.style.color);
      // 描边
      expect(modern.stroke).toBe(legacy.style.stroke);
      expect(modern.strokeThickness).toBe(legacy.style.strokeThickness);
      // 背景
      expect(modern.background).toBe("#000000");
      expect(modern.backgroundAlpha).toBe(0.65);
      // 内边距
      expect(modern.padding).toEqual(legacy.style.padding);
      // 字体（Phaser 把 fontStyle/fontSize/fontFamily 拼起来）
      expect(modern.font).toBe(legacy.font);
    }
  });

  /* ── 中心区域点位 ── */

  itWithBaseline("中心区域点位：圆逐点一致", () => {
    map.setCenterLocationId("square");
    map.setMainAreaPoints([
      { id: "p1", name: "点一", x: 200, y: 140, adjacentPointIds: [] },
      { id: "p2", name: "点二", x: 280, y: 220, adjacentPointIds: [] },
    ]);

    const legacyScene = makeLegacyScene(map);
    const legacyGraphics = legacyScene.buildMainAreaPointsOverlay();

    const scene = buildRenderScene({
      map,
      camera: makeContractCamera(),
      background: { source: "world-base", width: 640, height: 640 },
      characters: [],
      overlays: { mainAreaPoints: true },
      measureText,
    });

    const layer = scene.layers.find((l) => l.id === "main-area-points")!;

    // 老实现每个点画三笔：fillCircle(6) → strokeCircle(6) → fillCircle(2)
    const legacyFill = opsOf(legacyGraphics, "fillCircle");
    const legacyStroke = opsOf(legacyGraphics, "strokeCircle");

    const modernFills = layer.items.filter((i) => i.kind === "ellipse" && i.fill);
    const modernStrokes = layer.items.filter((i) => i.kind === "ellipse" && i.stroke);

    expect(modernFills.length).toBe(legacyFill.length);
    expect(modernStrokes.length).toBe(legacyStroke.length);

    for (let i = 0; i < legacyFill.length; i++) {
      const legacy = legacyFill[i].args as number[];
      const modern = modernFills[i] as { x: number; y: number; radiusX: number };
      expect(modern.x).toBe(legacy[0]);
      expect(modern.y).toBe(legacy[1]);
      expect(modern.radiusX).toBe(legacy[2]);
    }

    for (let i = 0; i < legacyStroke.length; i++) {
      const legacy = legacyStroke[i].args as number[];
      const modern = modernStrokes[i] as { x: number; y: number; radiusX: number };
      expect(modern.x).toBe(legacy[0]);
      expect(modern.y).toBe(legacy[1]);
      expect(modern.radiusX).toBe(legacy[2]);
    }
  });

  /* ── 可交互物件 + 物件名 ── */

  itWithBaseline("物件框：矩形逐点一致", () => {
    const legacyScene = makeLegacyScene(map);
    const legacyContainer = legacyScene.buildInteractiveObjectsOverlay();
    const legacyGraphics = legacyContainer.children[0];

    const scene = buildRenderScene({
      map,
      camera: makeContractCamera(),
      background: { source: "world-base", width: 640, height: 640 },
      characters: [],
      overlays: { interactiveObjects: true },
      measureText,
    });

    const layer = scene.layers.find((l) => l.id === "interactive-objects")!;
    const fills = layer.items.filter((i) => i.kind === "rect" && i.fill);
    const legacyFills = opsOf(legacyGraphics, "fillRect");

    expect(fills.length).toBe(legacyFills.length);
    for (let i = 0; i < legacyFills.length; i++) {
      const legacy = legacyFills[i].args as number[];
      const modern = fills[i] as { x: number; y: number; width: number; height: number };
      expect(modern.x).toBe(legacy[0]);
      expect(modern.y).toBe(legacy[1]);
      expect(modern.width).toBe(legacy[2]);
      expect(modern.height).toBe(legacy[3]);
    }
  });

  itWithBaseline("物件名：位置、内容、尺寸逐点一致", () => {
    const legacyScene = makeLegacyScene(map);
    const legacyContainer = legacyScene.buildInteractiveObjectsOverlay();
    const legacyTexts = legacyContainer.children.slice(1) as any[];

    const scene = buildRenderScene({
      map,
      camera: makeContractCamera(),
      background: { source: "world-base", width: 640, height: 640 },
      characters: [],
      overlays: { interactiveObjects: true },
      measureText,
    });

    const layer = scene.layers.find((l) => l.id === "labels")!;
    const modernLabels = layer.items as DrawText[];

    expect(modernLabels.length).toBe(legacyTexts.length);
    for (let i = 0; i < legacyTexts.length; i++) {
      const legacy = legacyTexts[i];
      const modern = modernLabels[i];
      expect(modern.x).toBe(legacy.x);
      expect(modern.y).toBe(legacy.y);
      expect(modern.content).toBe(legacy.content);
      expect(modern.width).toBe(legacy.width);
      expect(modern.height).toBe(legacy.height);
      expect(modern.color).toBe(legacy.style.color);
    }
  });

  /* ── 悬停高亮 + 悬停标签 ── */

  itWithBaseline("悬停高亮：圆角矩形逐点一致", () => {
    const legacyScene = makeLegacyScene(map);
    legacyScene.setupInteractiveObjectHover();
    // 触发「鼠标移到物件上」
    const zone = legacyScene.add.zone(0, 0, 0, 0);
    const target = legacyScene.mapManager
      .getInteractiveObjects()
      .find((o: any) => o.objectId === "obj_tea");
    // 替身把 zone 记在 `scene.zones`（Phaser 的 `add.zone` 不是一个容器）。
    const realZone = legacyScene.zones?.find(
      (z: any) => z.x === target.x && z.y === target.y,
    );
    expect(realZone, "老实现应该给每个物件建了 zone").toBeDefined();
    realZone.emit("pointerover");

    const legacyGraphics = legacyScene.interactiveHoverGraphics;

    const scene = buildRenderScene({
      map,
      camera: makeContractCamera(),
      background: { source: "world-base", width: 640, height: 640 },
      characters: [],
      hoveredObjectId: "obj_tea",
      measureText,
    });

    const layer = scene.layers.find((l) => l.id === "hover-highlight")!;
    const modernFills = layer.items.filter((i) => i.kind === "rect" && i.fill);
    const modernStrokes = layer.items.filter((i) => i.kind === "rect" && i.stroke);

    const legacyFill = opsOf(legacyGraphics, "fillRoundedRect");
    const legacyStroke = opsOf(legacyGraphics, "strokeRoundedRect");

    expect(modernFills.length).toBe(legacyFill.length);
    expect(modernStrokes.length).toBe(legacyStroke.length);

    for (let i = 0; i < legacyFill.length; i++) {
      const legacy = legacyFill[i].args as number[];
      const modern = modernFills[i] as {
        x: number; y: number; width: number; height: number; radius?: number;
      };
      expect(modern.x).toBe(legacy[0]);
      expect(modern.y).toBe(legacy[1]);
      expect(modern.width).toBe(legacy[2]);
      expect(modern.height).toBe(legacy[3]);
      expect(modern.radius).toBe(legacy[4]);
    }
  });

  itWithBaseline("悬停标签：容器位置与文字逐点一致", () => {
    const legacyScene = makeLegacyScene(map);
    legacyScene.setupInteractiveObjectHover();
    const target = legacyScene.mapManager
      .getInteractiveObjects()
      .find((o: any) => o.objectId === "obj_tea");
    // 替身把 zone 记在 `scene.zones`（Phaser 的 `add.zone` 不是一个容器）。
    const realZone = legacyScene.zones?.find(
      (z: any) => z.x === target.x && z.y === target.y,
    );
    realZone.emit("pointerover");

    const legacyContainer = legacyScene.interactiveHoverLabelContainer;
    const legacyBg = legacyScene.interactiveHoverLabelBg;
    const legacyText = legacyScene.interactiveHoverLabelText;

    const scene = buildRenderScene({
      map,
      camera: makeContractCamera(),
      background: { source: "world-base", width: 640, height: 640 },
      characters: [],
      hoveredObjectId: "obj_tea",
      measureText,
    });

    const labelLayer = scene.layers.find((l) => l.id === "hover-label")!;
    const modernBg = labelLayer.items.find((i) => i.id.startsWith("hover-label-bg")) as any;
    const modernText = labelLayer.items.find((i) => i.id.startsWith("hover-label:")) as DrawText;

    // 容器位置 = 文字位置（容器原点就是文字原点）
    expect(modernText.x).toBe(legacyContainer.x);
    expect(modernText.y).toBe(legacyContainer.y);
    // 文字内容与尺寸
    expect(modernText.content).toBe(legacyText.content);
    expect(modernText.width).toBe(legacyText.width);
    expect(modernText.height).toBe(legacyText.height);
    expect(modernText.color).toBe(legacyText.style.color);
    expect(modernText.stroke).toBe(legacyText.style.stroke);

    // 底：老实现是画在容器局部坐标 (-12, -8) 的圆角矩形
    const legacyBgOp = opsOf(legacyBg, "fillRoundedRect")[0];
    const legacyBgArgs = legacyBgOp.args as number[];
    expect(modernBg.x).toBe(legacyContainer.x + legacyBgArgs[0]);
    expect(modernBg.y).toBe(legacyContainer.y + legacyBgArgs[1]);
    expect(modernBg.width).toBe(legacyBgArgs[2]);
    expect(modernBg.height).toBe(legacyBgArgs[3]);
    expect(modernBg.radius).toBe(legacyBgArgs[4]);
  });

  /* ── 角色站位 ── */

  itWithBaseline("角色站位：中心区域点位逐点一致", () => {
    map.setCenterLocationId("square");
    map.setMainAreaPoints([
      { id: "p1", name: "点一", x: 200, y: 140, adjacentPointIds: [] },
      { id: "p2", name: "点二", x: 280, y: 220, adjacentPointIds: [] },
    ]);

    const legacyScene = makeLegacyScene(map);
    const legacyChars = [
      { id: "a", name: "甲", location: "square", mainAreaPointId: "p1" },
      { id: "b", name: "乙", location: "square", mainAreaPointId: "p1" },
      { id: "c", name: "丙", location: "square", mainAreaPointId: "p2" },
    ];

    // 老实现的 occupant 统计
    const mainAreaOccupants = new Map<string, string[]>();
    for (const char of legacyChars) {
      if (char.location !== map.getCenterLocationId() || !char.mainAreaPointId) continue;
      const occupants = mainAreaOccupants.get(char.mainAreaPointId) ?? [];
      occupants.push(char.id);
      mainAreaOccupants.set(char.mainAreaPointId, occupants);
    }

    const legacyPlacements = legacyChars.map((char) =>
      legacyScene.getCharacterPlacement(char, mainAreaOccupants),
    );

    const modernPlacements = resolveCharacterPlacements(
      map,
      legacyChars as CharacterRenderState[],
    );

    expectSamePoints(
      modernPlacements.map((p) => ({ x: p.x, y: p.y })),
      legacyPlacements,
      "角色站位",
    );
  });

  itWithBaseline("角色站位：非中心区域也逐点一致", () => {
    const legacyScene = makeLegacyScene(map);
    const legacyChars = [
      { id: "a", name: "甲", location: "alley", mainAreaPointId: null },
      { id: "b", name: "乙", location: "square", mainAreaPointId: null },
    ];

    const mainAreaOccupants = new Map<string, string[]>();
    // 两边各自跑一遍**同种子**的随机序列 ——
    // 站位走的是 `getRandomWalkablePointInLocation()`，
    // 里面 `Math.floor(Math.random() * pool.length)`。
    // 不固定住随机数，两边抽到的候选就不一样。
    const legacyPlacements = withSeededRandom(() =>
      legacyChars.map((char) =>
        legacyScene.getCharacterPlacement(char, mainAreaOccupants),
      ),
    );

    const modernPlacements = withSeededRandom(() =>
      resolveCharacterPlacements(map, legacyChars as CharacterRenderState[]),
    );

    expectSamePoints(
      modernPlacements.map((p) => ({ x: p.x, y: p.y })),
      legacyPlacements,
      "角色站位（非中心）",
    );
  });

  /* ── 角色几何 ── */

  itWithBaseline("角色图元：阴影与本体逐点一致", () => {
    const legacyScene = makeLegacyScene(map);
    const metrics = createCharacterDisplayMetrics(640, 640);

    // 老实现：造一个 CharacterSprite（无贴图 → 圆）
    const legacySprite = new baseline!.CharacterSprite(legacyScene, 100, 300, {
      characterId: "nobody-has-this-texture",
      name: "甲",
      color: 0x6c5ce7,
      displayMetrics: metrics,
    });

    const scene = buildRenderScene({
      map,
      camera: makeContractCamera(),
      background: { source: "world-base", width: 640, height: 640 },
      characters: [makeCharacter({ id: "c1", x: 100, y: 300 })],
      displayMetrics: metrics,
      measureText,
    });

    const layer = scene.layers.find((l) => l.id === "characters")!;
    const shadow = layer.items.find((i) => i.id === "character-shadow:c1") as any;
    const body = layer.items.find((i) => i.id === "character:c1") as any;
    const highlight = layer.items.find((i) => i.id === "character-highlight:c1") as any;

    // 老实现的图形：容器里第一个是阴影，第二个是本体容器
    const legacyShadow = legacySprite.children[0] as any;
    const legacyBodyContainer = legacySprite.children[1] as any;
    const legacyCircle = legacyBodyContainer.children[0] as any;
    const legacyHighlight = legacyBodyContainer.children[1] as any;

    // 阴影
    expect(shadow.x).toBe(legacySprite.x + legacyShadow.x);
    expect(shadow.y).toBe(legacySprite.y + legacyShadow.y);
    expect(shadow.radiusX).toBe(legacyShadow.width / 2);
    expect(shadow.radiusY).toBe(legacyShadow.height / 2);

    // 本体（圆）
    expect(body.x).toBe(legacySprite.x + legacyCircle.x);
    expect(body.y).toBe(legacySprite.y + legacyCircle.y);
    expect(body.radiusX).toBe(legacyCircle.radius);
    expect(body.radiusY).toBe(legacyCircle.radius);

    // 高光弧
    expect(highlight.x).toBe(legacySprite.x + legacyHighlight.x);
    expect(highlight.y).toBe(legacySprite.y + legacyHighlight.y);
    expect(highlight.radiusX).toBe(legacyHighlight.radius);
  });

  itWithBaseline("角色名牌：屏幕坐标逐点一致", () => {
    const legacyScene = makeLegacyScene(map);
    const metrics = createCharacterDisplayMetrics(640, 640);

    // 角色必须**在视口内** ——
    // 旧实现对视口外的角色提前 return，`style.left` 根本不写。
    // （相机 scrollX=1234、zoom=0.75，世界 x=100 落在屏幕外。）
    const worldX = LEGACY_CAMERA.scrollX + 200;
    const worldY = LEGACY_CAMERA.scrollY + 150;

    const legacySprite = new baseline!.CharacterSprite(legacyScene, worldX, worldY, {
      characterId: "nobody-has-this-texture",
      name: "甲",
      color: 0x6c5ce7,
      displayMetrics: metrics,
    });
    legacySprite.syncOverlayZoom(LEGACY_CAMERA.zoom);

    // 老实现把坐标写进 DOM 元素的 style
    const labelRoot = (legacySprite as any).labelRoot;
    expect(labelRoot, "老实现应该建了名牌元素").toBeTruthy();

    const scene = buildRenderScene({
      map,
      camera: makeContractCamera(),
      background: { source: "world-base", width: 640, height: 640 },
      characters: [makeCharacter({ id: "c1", x: worldX, y: worldY })],
      displayMetrics: metrics,
      measureText,
    });

    const modernLabel = scene.overlays.find((o) => o.kind === "character-label")!;

    // 老实现：`left` / `top` 是取整过的屏幕坐标
    expect(labelRoot.style.left, "老实现应该写了名牌坐标").toBeTruthy();
    expect(modernLabel.x).toBe(Number.parseFloat(labelRoot.style.left.replace("px", "")));
    expect(modernLabel.y).toBe(Number.parseFloat(labelRoot.style.top.replace("px", "")));
    // 可见性也要一致（旧实现对视口外的角色隐藏名牌）
    expect(modernLabel.visible).toBe(true);
  });

  itWithBaseline("头顶偏移与气泡锚点逐点一致", () => {
    const metrics = createCharacterDisplayMetrics(640, 640);

    const legacyScene = makeLegacyScene(map);
    const legacySprite = new baseline!.CharacterSprite(legacyScene, 100, 300, {
      characterId: "nobody-has-this-texture",
      name: "甲",
      color: 0x6c5ce7,
      displayMetrics: metrics,
    });

    // 老的 `getHeadWorldOffset` / `getBubbleAnchorOffsetY` 是私有方法，
    // 但运行时还在 —— 直接调，比的是**老代码自己的算术**。
    expect(getHeadWorldOffset(metrics, false)).toBe(
      (legacySprite as any).getHeadWorldOffset(),
    );
    expect(getBubbleAnchorOffsetY(metrics, false)).toBe(
      (legacySprite as any).getBubbleAnchorOffsetY(),
    );
  });

  /* ── 角色排序 ── */

  itWithBaseline("角色排序：按脚底 y 排序，逐点一致", () => {
    const metrics = createCharacterDisplayMetrics(640, 640);
    const legacyScene = makeLegacyScene(map);

    const positions = [
      { id: "a", x: 100, y: 100 },
      { id: "b", x: 100, y: 400 },
      { id: "c", x: 100, y: 250 },
    ];

    // 老实现：造三个 sprite，放进 entityLayer，然后排序
    const entityLayer = legacyScene.add.container(0, 0);
    const legacySprites = positions.map((p) => {
      const sprite = new baseline!.CharacterSprite(legacyScene, p.x, p.y, {
        // 老实现把 `characterId` 当**贴图 key** 用 ——
        // 贴图不存在时画圆。这里给唯一 key，才能读回它的身份。
        characterId: p.id,
        name: p.id,
        color: 0x6c5ce7,
        displayMetrics: metrics,
      });
      entityLayer.add(sprite);
      return sprite;
    });
    entityLayer.list.sort((a: any, b: any) => a.getSortFootY() - b.getSortFootY());

    const scene = buildRenderScene({
      map,
      camera: makeContractCamera(),
      background: { source: "world-base", width: 640, height: 640 },
      characters: positions.map((p) => makeCharacter({ id: p.id, x: p.x, y: p.y })),
      displayMetrics: metrics,
      measureText,
    });

    const layer = scene.layers.find((l) => l.id === "characters")!;
    const modernOrder = layer.items
      .filter((i) => i.id.startsWith("character:") && !i.id.includes("shadow"))
      .map((i) => i.id.replace("character:", ""));

    expect(modernOrder).toEqual(
      (entityLayer.list as any[]).map((s) => s.characterId),
    );
    expect(legacySprites).toHaveLength(3);
  });
});

/** 一个角色。 */
function makeCharacter(
  overrides: Partial<CharacterRenderState> = {},
): CharacterRenderState {
  return {
    id: "c1",
    name: "甲",
    location: "alley",
    mainAreaPointId: null,
    spriteSource: null,
    ...overrides,
  };
}
