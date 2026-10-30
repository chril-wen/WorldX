/**
 * 场景构建器的单测 —— 坐标变换、图层 depth 顺序、覆盖层开关、空状态。
 *
 * ## 这些测试在防什么
 *
 * 阶段 8.1 的全部意义是「位置逻辑只写一遍」。
 * 写一遍的前提是**这一份是对的** ——
 * 而「对」有两层意思：
 *
 * 1. **跟改造前一样** —— 由 `scene-builder.ab.test.ts` 保证（逐点对比老实现）
 * 2. **自己站得住** —— 由本文件保证（不依赖基准也能说清每条规则）
 *
 * 第 2 层很重要：基准拿不到时会跳过 A/B（不红），
 * 这时本文件就是唯一的防线。
 */

import { describe, it, expect } from "vitest";
import { MapManager } from "../map-model.js";
import {
  buildRenderScene,
  getBubbleAnchorOffsetY,
  getHeadWorldOffset,
  getIdleFrame,
  getSortFootY,
  hitTestScene,
  resolveCharacterPlacements,
  SCENE_LAYER_DEPTHS,
  SCENE_LAYER_IDS,
  type CharacterRenderState,
  type SceneBuilderInput,
} from "./scene-builder.js";
import { createCharacterDisplayMetrics } from "./character-metrics.js";
import type { CameraState, DrawText } from "./render-model.js";

/* ── 测试用的地图 ──────────────────────────────────────────────── */

/**
 * 造一张 Tiled JSON。
 *
 * 跟 `map-model.test.ts` 的 helper 同构 —— 阶段 5 已经验证过
 * 解析在两处是一致的。
 */
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

/** 一张有区域、有物件、有碰撞的地图。 */
function makeMap(overrides: Parameters<typeof makeTiled>[0] = {}) {
  const collision = new Array(400).fill(0);
  // 挡一堵墙 —— 让可行走区域不是一整块
  for (let x = 0; x < 20; x++) collision[10 * 20 + x] = 1;
  const map = new MapManager();
  map.loadFromTiledJSON(
    makeTiled({
      collision,
      regions: [
        { id: "alley", name: "巷口", x: 32, y: 32, w: 128, h: 96 },
        { id: "square", name: "集市", x: 192, y: 128, w: 160, h: 160 },
      ],
      objects: [
        { objectId: "obj_tea", name: "茶壶", x: 64, y: 96, w: 32, h: 32 },
        { objectId: "obj_stall", name: "摊子", x: 160, y: 96, w: 48, h: 32 },
      ],
      ...overrides,
    }) as any,
  );
  return map;
}

/** 一张完全空的地图。 */
function makeEmptyMap() {
  const map = new MapManager();
  map.loadFromTiledJSON(makeTiled() as any);
  return map;
}

/* ── 测试用的相机 ──────────────────────────────────────────────── */

/** 一台相机 —— 变换参数都在这儿，一眼能看出期望值。 */
function makeCamera(overrides: Partial<CameraState> = {}): CameraState {
  return {
    scrollX: 100,
    scrollY: 200,
    zoom: 1,
    viewportX: 0,
    viewportY: 0,
    viewportWidth: 800,
    viewportHeight: 600,
    mapWidth: 640,
    mapHeight: 640,
    ...overrides,
  };
}

/** 一个角色。 */
function makeCharacter(
  overrides: Partial<CharacterRenderState> = {},
): CharacterRenderState {
  return {
    id: "c1",
    name: "小明",
    location: "alley",
    mainAreaPointId: null,
    spriteSource: null,
    ...overrides,
  };
}

/**
 * 一个「可预测」的文字测量函数。
 *
 * 每个字符固定 10px 宽、一行 20px 高 —— 这样尺寸是算得出来的，
 * 断言能写死数字，不用靠「差不多」。
 */
const measureText = (text: string) => ({
  width: text.length * 10,
  height: 20,
});

/** 造一个场景。 */
function build(
  overrides: Partial<SceneBuilderInput> = {},
): ReturnType<typeof buildRenderScene> {
  return buildRenderScene({
    map: makeMap(),
    camera: makeCamera(),
    background: { source: "world-base", width: 640, height: 640 },
    characters: [],
    measureText,
    ...overrides,
  });
}

/* ── 坐标变换 ──────────────────────────────────────────────────── */

/**
 * 名牌的期望 y —— **在头顶，不在脚底**。
 *
 * 名牌 y = `屏幕脚底 y - 头顶偏移 × 缩放`，然后取整。
 * （这跟旧 `CharacterSprite.updateDomLabelPosition()` 一个算法。）
 */
function expectedLabelY(
  camera: CameraState,
  worldY: number,
  metrics: ReturnType<typeof createCharacterDisplayMetrics>,
  hasSprite = false,
): number {
  const screenY = (worldY - camera.scrollY) * camera.zoom + camera.viewportY;
  const headOffset = getHeadWorldOffset(metrics, hasSprite);
  return Math.round(screenY - headOffset * camera.zoom);
}

describe("坐标变换", () => {
  it("世界坐标 → 屏幕坐标：契约公式", () => {
    const camera = makeCamera({ scrollX: 100, scrollY: 200, zoom: 1 });
    const metrics = createCharacterDisplayMetrics(camera.mapWidth, camera.mapHeight);

    const scene = build({
      camera,
      characters: [makeCharacter({ x: 150, y: 260 })],
      displayMetrics: metrics,
    });

    const label = scene.overlays.find((o) => o.kind === "character-label")!;
    // screenX = (150 - 100) * 1 + 0 = 50
    expect(label.x).toBe(50);
    // screenY = (260 - 200) * 1 + 0 = 60，再减去头顶偏移
    expect(label.y).toBe(expectedLabelY(camera, 260, metrics));
  });

  it("缩放会同时作用于 x 和 y", () => {
    const camera = makeCamera({ scrollX: 0, scrollY: 0, zoom: 0.5 });
    const metrics = createCharacterDisplayMetrics(camera.mapWidth, camera.mapHeight);

    const scene = build({
      camera,
      characters: [makeCharacter({ x: 200, y: 400 })],
      displayMetrics: metrics,
    });

    const label = scene.overlays.find((o) => o.kind === "character-label")!;
    // (200 - 0) * 0.5 = 100
    expect(label.x).toBe(100);
    expect(label.y).toBe(expectedLabelY(camera, 400, metrics));
  });

  it("视口偏移会加在最后", () => {
    const camera = makeCamera({
      scrollX: 0,
      scrollY: 0,
      zoom: 1,
      viewportX: 30,
      viewportY: 40,
    });
    const metrics = createCharacterDisplayMetrics(camera.mapWidth, camera.mapHeight);

    const scene = build({
      camera,
      characters: [makeCharacter({ x: 100, y: 100 })],
      displayMetrics: metrics,
    });

    const label = scene.overlays.find((o) => o.kind === "character-label")!;
    expect(label.x).toBe(130);
    expect(label.y).toBe(expectedLabelY(camera, 100, metrics));
  });

  it("名牌挂在头顶，不在脚底", () => {
    const camera = makeCamera({ scrollX: 0, scrollY: 0, zoom: 1 });
    const map = makeMap();
    const metrics = createCharacterDisplayMetrics(camera.mapWidth, camera.mapHeight);

    const scene = build({
      map,
      camera,
      characters: [makeCharacter({ x: 100, y: 300, spriteSource: null })],
      displayMetrics: metrics,
    });

    const label = scene.overlays.find((o) => o.kind === "character-label")!;
    // 无贴图时头顶偏移 = 圆半径 × 1.1
    const headOffset = getHeadWorldOffset(metrics, false);
    expect(label.y).toBe(Math.round(300 - headOffset));
    // 明确比脚底高
    expect(label.y).toBeLessThan(300);
  });

  it("名牌坐标取整（跟旧实现一致）", () => {
    const camera = makeCamera({ scrollX: 0, scrollY: 0, zoom: 0.333 });
    const metrics = createCharacterDisplayMetrics(camera.mapWidth, camera.mapHeight);

    const scene = build({
      camera,
      characters: [makeCharacter({ x: 101, y: 103 })],
      displayMetrics: metrics,
    });

    const label = scene.overlays.find((o) => o.kind === "character-label")!;
    expect(label.x).toBe(Math.round(101 * 0.333));
    expect(label.y).toBe(expectedLabelY(camera, 103, metrics));
    expect(Number.isInteger(label.x)).toBe(true);
    expect(Number.isInteger(label.y)).toBe(true);
  });

  it("气泡挂在角色头顶上方", () => {
    const camera = makeCamera({ scrollX: 0, scrollY: 0, zoom: 1 });
    const metrics = createCharacterDisplayMetrics(camera.mapWidth, camera.mapHeight);

    const scene = build({
      camera,
      characters: [makeCharacter({ id: "c1", x: 200, y: 400 })],
      bubbles: [{ characterId: "c1", content: "你好" }],
      displayMetrics: metrics,
    });

    const bubble = scene.overlays.find((o) => o.kind === "dialogue-bubble")!;
    const anchorY = 400 + getBubbleAnchorOffsetY(metrics, false);
    expect(bubble.x).toBe(200);
    expect(bubble.y).toBe(Math.round(anchorY));
  });

  it("没有测量函数时也照样产出名牌（只是不知道框多大）", () => {
    const scene = build({
      characters: [makeCharacter({ x: 100, y: 100 })],
      measureText: undefined,
    });

    expect(scene.overlays).toHaveLength(1);
  });
});

/* ── 图层 depth 顺序 ───────────────────────────────────────────── */

describe("图层 depth 顺序", () => {
  it("所有覆盖层都开时，图层按 depth 升序", () => {
    const scene = build({
      overlays: {
        walkable: true,
        regionBounds: true,
        mainAreaPoints: true,
        interactiveObjects: true,
      },
      hoveredObjectId: "obj_tea",
      map: makeMap(),
    });

    const depths = scene.layers.map((l) => l.depth);
    expect(depths).toEqual([...depths].sort((a, b) => a - b));
  });

  it("depth 与改造前的 Phaser 一致", () => {
    expect(SCENE_LAYER_DEPTHS.walkable).toBe(4);
    expect(SCENE_LAYER_DEPTHS.characters).toBe(10);
    expect(SCENE_LAYER_DEPTHS.hoverHighlight).toBe(15);
    expect(SCENE_LAYER_DEPTHS.regionBounds).toBe(16);
    expect(SCENE_LAYER_DEPTHS.mainAreaPoints).toBe(16);
    expect(SCENE_LAYER_DEPTHS.interactiveObjects).toBe(16);
    expect(SCENE_LAYER_DEPTHS.hoverLabel).toBe(16);
    expect(SCENE_LAYER_DEPTHS.labels).toBe(17);
  });

  it("可行走覆盖层在角色下面", () => {
    const scene = build({
      overlays: { walkable: true },
      characters: [makeCharacter({ x: 100, y: 100 })],
    });

    const walkable = scene.layers.find((l) => l.id === SCENE_LAYER_IDS.walkable)!;
    const characters = scene.layers.find((l) => l.id === SCENE_LAYER_IDS.characters)!;
    expect(walkable.depth).toBeLessThan(characters.depth);
  });

  it("角色层在悬停高亮下面", () => {
    const scene = build({
      hoveredObjectId: "obj_tea",
      characters: [makeCharacter({ x: 100, y: 100 })],
    });

    const characters = scene.layers.find((l) => l.id === SCENE_LAYER_IDS.characters)!;
    const hover = scene.layers.find((l) => l.id === SCENE_LAYER_IDS.hoverHighlight)!;
    expect(characters.depth).toBeLessThan(hover.depth);
  });

  it("区域名文字在区域框上面", () => {
    const scene = build({ overlays: { regionBounds: true } });

    const bounds = scene.layers.find((l) => l.id === SCENE_LAYER_IDS.regionBounds)!;
    const labels = scene.layers.find((l) => l.id === SCENE_LAYER_IDS.labels)!;
    expect(bounds.depth).toBeLessThan(labels.depth);
  });

  it("角色按脚底 y 排序 —— 站得靠下的盖住靠上的", () => {
    const camera = makeCamera();
    const metrics = createCharacterDisplayMetrics(camera.mapWidth, camera.mapHeight);

    const scene = build({
      camera,
      displayMetrics: metrics,
      characters: [
        makeCharacter({ id: "far", x: 100, y: 100 }),
        makeCharacter({ id: "near", x: 100, y: 400 }),
        makeCharacter({ id: "mid", x: 100, y: 250 }),
      ],
    });

    const layer = scene.layers.find((l) => l.id === SCENE_LAYER_IDS.characters)!;
    const ids = layer.items
      .filter((i) => i.id.startsWith("character:"))
      .map((i) => i.id);
    expect(ids).toEqual(["character:far", "character:mid", "character:near"]);
  });

  it("脚底 y 相同时保持原顺序（稳定排序）", () => {
    const camera = makeCamera();
    const metrics = createCharacterDisplayMetrics(camera.mapWidth, camera.mapHeight);

    const scene = build({
      camera,
      displayMetrics: metrics,
      characters: [
        makeCharacter({ id: "a", x: 100, y: 200 }),
        makeCharacter({ id: "b", x: 100, y: 200 }),
        makeCharacter({ id: "c", x: 100, y: 200 }),
      ],
    });

    const layer = scene.layers.find((l) => l.id === SCENE_LAYER_IDS.characters)!;
    const ids = layer.items
      .filter((i) => i.id.startsWith("character:"))
      .map((i) => i.id);
    expect(ids).toEqual(["character:a", "character:b", "character:c"]);
  });
});

/* ── 覆盖层开关 ────────────────────────────────────────────────── */

describe("覆盖层开关", () => {
  it("默认全关 —— 只有角色层", () => {
    const scene = build({
      characters: [makeCharacter({ x: 100, y: 100 })],
    });

    const ids = scene.layers.map((l) => l.id);
    expect(ids).toEqual([SCENE_LAYER_IDS.characters]);
  });

  it("开关打开才产出对应图层", () => {
    const scene = build({
      overlays: { walkable: true, regionBounds: true },
    });

    const ids = scene.layers.map((l) => l.id);
    expect(ids).toContain(SCENE_LAYER_IDS.walkable);
    expect(ids).toContain(SCENE_LAYER_IDS.regionBounds);
    expect(ids).not.toContain(SCENE_LAYER_IDS.mainAreaPoints);
    expect(ids).not.toContain(SCENE_LAYER_IDS.interactiveObjects);
  });

  it("关掉区域框时区域名也不产出", () => {
    const scene = build({ overlays: { regionBounds: false } });

    const ids = scene.layers.map((l) => l.id);
    expect(ids).not.toContain(SCENE_LAYER_IDS.labels);
  });

  it("没有物件时物件图层是空的（不产出空图层）", () => {
    const map = new MapManager();
    map.loadFromTiledJSON(makeTiled() as any);

    const scene = build({
      map,
      overlays: { interactiveObjects: true },
    });

    expect(scene.layers.find((l) => l.id === SCENE_LAYER_IDS.interactiveObjects)).toBeUndefined();
  });

  it("可行走覆盖层把同一行的连续格子合成一个矩形", () => {
    const scene = build({ overlays: { walkable: true } });

    const layer = scene.layers.find((l) => l.id === SCENE_LAYER_IDS.walkable)!;
    const fills = layer.items.filter((i) => i.kind === "rect" && i.fill);
    // 20 格宽，第一行整行可走 → 一个矩形
    expect(fills.length).toBeGreaterThan(0);
    const first = fills[0] as { width: number; height: number };
    expect(first.width).toBe(20 * 32);
    expect(first.height).toBe(32);
  });

  it("悬停物件不在地图里时不产出任何东西", () => {
    const scene = build({ hoveredObjectId: "不存在的物件" });

    const ids = scene.layers.map((l) => l.id);
    expect(ids).not.toContain(SCENE_LAYER_IDS.hoverHighlight);
    expect(ids).not.toContain(SCENE_LAYER_IDS.hoverLabel);
  });

  it("悬停物件时产出高亮和标签", () => {
    const scene = build({ hoveredObjectId: "obj_tea" });

    const ids = scene.layers.map((l) => l.id);
    expect(ids).toContain(SCENE_LAYER_IDS.hoverHighlight);
    expect(ids).toContain(SCENE_LAYER_IDS.hoverLabel);
  });

  it("悬停角色会给贴图染色", () => {
    const scene = build({
      characters: [makeCharacter({ id: "c1", x: 100, y: 100, spriteSource: "c1" })],
      hoveredCharacterId: "c1",
    });

    const layer = scene.layers.find((l) => l.id === SCENE_LAYER_IDS.characters)!;
    const sprite = layer.items.find((i) => i.id === "character:c1")!;
    expect((sprite as { tint?: string }).tint).toBe("#ddddff");
  });

  it("没悬停时不染色", () => {
    const scene = build({
      characters: [makeCharacter({ id: "c1", x: 100, y: 100, spriteSource: "c1" })],
    });

    const layer = scene.layers.find((l) => l.id === SCENE_LAYER_IDS.characters)!;
    const sprite = layer.items.find((i) => i.id === "character:c1")!;
    expect((sprite as { tint?: string }).tint).toBeUndefined();
  });
});

/* ── 空状态 ────────────────────────────────────────────────────── */

describe("空状态", () => {
  it("空地图 + 空角色 → 空场景，但不崩", () => {
    const scene = buildRenderScene({
      map: makeEmptyMap(),
      camera: makeCamera(),
      background: { source: "world-base", width: 640, height: 640 },
      characters: [],
    });

    expect(scene.layers).toEqual([]);
    expect(scene.overlays).toEqual([]);
    expect(scene.background.source).toBe("world-base");
  });

  it("没有任何输入可选参数也不崩", () => {
    const scene = buildRenderScene({
      map: makeEmptyMap(),
      camera: makeCamera(),
      background: { source: "world-base", width: 640, height: 640 },
      characters: [],
    });

    expect(scene.camera.zoom).toBe(1);
    expect(Array.isArray(scene.layers)).toBe(true);
  });

  it("角色列表为空时覆盖层也为空数组", () => {
    const scene = build({ bubbles: [] });
    expect(scene.overlays).toEqual([]);
  });

  it("气泡指向不存在的角色时不产出气泡", () => {
    const scene = build({
      characters: [makeCharacter({ id: "c1", x: 100, y: 100 })],
      bubbles: [{ characterId: "不存在", content: "hi" }],
    });

    expect(scene.overlays.filter((o) => o.kind === "dialogue-bubble")).toHaveLength(0);
  });
});

/* ── 角色几何 ──────────────────────────────────────────────────── */

describe("角色几何", () => {
  const metrics = createCharacterDisplayMetrics(640, 640);

  it("头顶偏移：有贴图按 originY 算，无贴图按圆半径算", () => {
    // 贴图：高 × 0.85（originY）× 0.85（切透明边）
    expect(getHeadWorldOffset(metrics, true)).toBe(metrics.spriteHeight * 0.85 * 0.85);
    // 圆：半径 × 1.1
    expect(getHeadWorldOffset(metrics, false)).toBe(metrics.circleRadius * 1.1);
  });

  it("气泡偏移：有贴图用 bubbleOffsetY，无贴图用 -圆半径×4.2", () => {
    expect(getBubbleAnchorOffsetY(metrics, true)).toBe(metrics.bubbleOffsetY);
    expect(getBubbleAnchorOffsetY(metrics, false)).toBe(-metrics.circleRadius * 4.2);
  });

  it("排序脚底 y：有贴图加 sortFootYOffset，无贴图加圆半径×0.65", () => {
    expect(getSortFootY(metrics, true, 100)).toBe(100 + metrics.sortFootYOffset);
    expect(getSortFootY(metrics, false, 100)).toBe(100 + metrics.circleRadius * 0.65);
  });

  it("站桩帧：正面 18、背面 19、侧面 20（朝右翻转）", () => {
    expect(getIdleFrame("down")).toEqual({ frame: 18, flipX: false });
    expect(getIdleFrame("up")).toEqual({ frame: 19, flipX: false });
    expect(getIdleFrame("left")).toEqual({ frame: 20, flipX: false });
    expect(getIdleFrame("right")).toEqual({ frame: 20, flipX: true });
  });
});

/* ── 站位 ──────────────────────────────────────────────────────── */

describe("角色站位", () => {
  it("显式给了位置就用它", () => {
    const map = makeMap();
    const placements = resolveCharacterPlacements(map, [
      makeCharacter({ id: "c1", x: 123, y: 456 }),
    ]);

    expect(placements[0].x).toBe(123);
    expect(placements[0].y).toBe(456);
  });

  it("只给 x 或只给 y 时按「没给」处理（两个都要有）", () => {
    const map = makeMap();
    const placements = resolveCharacterPlacements(map, [
      makeCharacter({ id: "c1", x: 123 }),
    ]);

    // 没给 y → 走正常站位逻辑，不该是 123
    expect(placements[0].x).not.toBe(123);
  });

  it("中心区域的角色站到自己的点位上", () => {
    const map = makeMap();
    map.setCenterLocationId("square");
    map.setMainAreaPoints([
      { id: "p1", name: "点一", x: 200, y: 140, adjacentPointIds: [] },
    ]);

    const placements = resolveCharacterPlacements(map, [
      makeCharacter({ id: "c1", location: "square", mainAreaPointId: "p1" }),
    ]);

    // 点位在 (200, 140)，周围可走 → 位置落在点位附近
    expect(Math.abs(placements[0].x - 200)).toBeLessThan(80);
    expect(Math.abs(placements[0].y - 140)).toBeLessThan(80);
  });

  it("同一个点位上多个角色会错开", () => {
    const map = makeMap();
    map.setCenterLocationId("square");
    map.setMainAreaPoints([
      { id: "p1", name: "点一", x: 200, y: 140, adjacentPointIds: [] },
    ]);

    const placements = resolveCharacterPlacements(map, [
      makeCharacter({ id: "a", location: "square", mainAreaPointId: "p1" }),
      makeCharacter({ id: "b", location: "square", mainAreaPointId: "p1" }),
    ]);

    expect(placements[0].x).not.toBe(placements[1].x);
  });

  it("位置算不出来时退到 (400, 300)", () => {
    const map = makeMap();
    // 全是墙 —— 哪都走不了
    const blocked = new MapManager();
    blocked.loadFromTiledJSON(
      makeTiled({ collision: new Array(400).fill(1) }) as any,
    );
    blocked.setCenterLocationId("square");

    const placements = resolveCharacterPlacements(blocked, [
      makeCharacter({ id: "c1", location: "square" }),
    ]);

    expect(placements[0]).toEqual(
      expect.objectContaining({ x: 400, y: 300 }),
    );
    expect(map).toBeTruthy();
  });
});

/* ── 命中测试 ──────────────────────────────────────────────────── */

describe("命中测试", () => {
  it("点中物件返回它的 id", () => {
    const scene = build({ overlays: { interactiveObjects: true } });
    // 茶壶在 (64, 96)，32×32
    expect(hitTestScene(scene, 70, 100)).toBe("object-fill:obj_tea");
  });

  it("点空白返回 null", () => {
    const scene = build({ overlays: { interactiveObjects: true } });
    expect(hitTestScene(scene, 500, 500)).toBeNull();
  });

  it("上层优先 —— 区域名文字层不吃命中，但角色层会", () => {
    const scene = build({ characters: [makeCharacter({ id: "c1", x: 100, y: 100 })] });
    // 角色没有矩形图元（只有圆），所以点它命中不了
    expect(hitTestScene(scene, 100, 100)).toBeNull();
  });
});

/* ── 标签图元 ──────────────────────────────────────────────────── */

describe("标签图元", () => {
  it("区域名是带底色的 chip，位置在区域框左上方", () => {
    const scene = build({ overlays: { regionBounds: true } });
    const layer = scene.layers.find((l) => l.id === SCENE_LAYER_IDS.labels)!;

    const label = layer.items.find(
      (i) => i.id === "region-label:alley",
    ) as DrawText;
    expect(label).toBeDefined();
    // 区域在 (32, 32) → 标签在 (38, max(6, 10))
    expect(label.x).toBe(38);
    expect(label.y).toBe(10);
    expect(label.background).toBe("#000000");
    expect(label.backgroundAlpha).toBe(0.65);
    expect(label.padding).toEqual({ left: 6, right: 6, top: 3, bottom: 3 });
  });

  it("chip 的框宽 = 文字宽 + 描边 + 左右内边距", () => {
    const scene = build({ overlays: { regionBounds: true } });
    const layer = scene.layers.find((l) => l.id === SCENE_LAYER_IDS.labels)!;

    const label = layer.items.find(
      (i) => i.id === "region-label:alley",
    ) as DrawText;
    // 文字「巷口」= 2 字 × 10px = 20；描边 2 → ceil(22) = 22；内边距 12 → 34
    expect(label.width).toBe(20 + 2 + 6 + 6);
    // 文字高 20 + 描边 2 = 22；内边距 6 → 28
    expect(label.height).toBe(20 + 2 + 3 + 3);
  });

  it("区域名顶到画面外时压回 6", () => {
    const map = new MapManager();
    map.loadFromTiledJSON(
      makeTiled({
        regions: [{ id: "top", name: "顶上", x: 0, y: 0, w: 32, h: 32 }],
      }) as any,
    );

    const scene = build({ map, overlays: { regionBounds: true } });
    const layer = scene.layers.find((l) => l.id === SCENE_LAYER_IDS.labels)!;
    const label = layer.items.find((i) => i.id === "region-label:top") as DrawText;
    // max(6, 0 - 22) = 6
    expect(label.y).toBe(6);
  });

  it("物件名也是 chip", () => {
    const scene = build({ overlays: { interactiveObjects: true } });
    const layer = scene.layers.find((l) => l.id === SCENE_LAYER_IDS.labels)!;

    const label = layer.items.find(
      (i) => i.id === "object-label:obj_tea",
    ) as DrawText;
    expect(label).toBeDefined();
    expect(label.background).toBe("#000000");
  });
});
