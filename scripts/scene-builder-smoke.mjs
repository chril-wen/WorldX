/**
 * 冒烟脚本 —— 真实世界的场景构建，新旧实现**逐点对比**。
 *
 * ## 为什么要有这个
 *
 * `scene-builder.ab.test.ts` 用的是**人造地图**。人造地图只覆盖了我们想到的情况；
 * 真实世界的 TMJ 有各种怪东西 —— 额外的层、缺失的层、properties 里的
 * 意外类型、区域名带中文、物件 id 跟区域 id 撞名、tilewidth 不是 32。
 *
 * 位置逻辑在真实数据上出错，症状是「角色站在奇怪的��方」「名牌飘在地图外」——
 * 这类问题**单元测试测不出来**，得拿真数据跑。
 *
 * ## 跟 A/B 测试的分工
 *
 * - A/B 测试（`scene-builder.ab.test.ts`）—— 人造地图，**每一类图元**都逐点比
 * - 这个脚本 —— 真实地图，**整体产物**逐点比（覆盖层、标签、站位）
 *
 * 两者缺一不可：前者保证「每种算法都对」，后者保证「在真数据上也对」。
 *
 * ## 怎么用
 *
 *     node scripts/scene-builder-smoke.mjs
 *
 * 退出码 0 = 全部一致；非 0 = 有差异（会打印具体差在哪）。
 */

import { existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

/** 找到仓库里所有真实世界。 */
function findWorlds() {
  const worlds = [];
  for (const base of [
    join(ROOT, "output", "worlds"),
    join(ROOT, "library", "worlds"),
  ]) {
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const tmjPath = join(base, entry.name, "map", "06-final.tmj");
      if (existsSync(tmjPath)) {
        worlds.push({ name: entry.name, tmjPath });
      }
    }
  }
  return worlds;
}

/** 加载新实现（client-core 源码，走 tsx）。 */
async function loadNew() {
  const { tsImport } = await import("tsx/esm/api");
  const clientCore = await tsImport(
    pathToFileURL(
      join(ROOT, "packages", "client-core", "src", "index.ts"),
    ).href,
    import.meta.url,
  );
  return clientCore;
}

/** 加载改造前的场景实现 —— 从 git 历史提取。 */
async function loadLegacy() {
  const { tsImport } = await import("tsx/esm/api");
  const { loadLegacySceneBaseline } = await tsImport(
    pathToFileURL(
      join(
        ROOT,
        "packages",
        "client-core",
        "src",
        "testing",
        "legacy-scene-baseline.ts",
      ),
    ).href,
    import.meta.url,
  );
  const loaded = await loadLegacySceneBaseline();
  if (!loaded.ok) {
    console.log(`[Smoke] 跳过 —— 拿不到改造前基准：${loaded.reason}`);
    return null;
  }
  return loaded;
}

/**
 * 一个**确定性**的文字测量。
 *
 * 必须跟 A/B 测试用同一个 —— 两边量出来的尺寸不一样，
 * 比出来的差异就不是「位置逻辑」的差异。
 */
function measureText(text, font) {
  const size = /(\d+(?:\.\d+)?)px/.exec(font);
  const fontSize = size ? Number(size[1]) : 16;
  return { width: text.length * 10, height: fontSize };
}

/** 把场景压成「可比较的形状」—— 只留位置和尺寸。 */
function shapeOf(items) {
  return items.map((item) => {
    const out = { kind: item.kind, x: item.x, y: item.y };
    if (item.width !== undefined) out.width = item.width;
    if (item.height !== undefined) out.height = item.height;
    // 圆角矩形用 `radius`；椭圆用 `radiusX` / `radiusY`。
    if (item.radius !== undefined) out.radius = item.radius;
    if (item.radiusX !== undefined) out.radiusX = item.radiusX;
    if (item.radiusY !== undefined) out.radiusY = item.radiusY;
    if (item.content !== undefined) out.content = item.content;
    return out;
  });
}

/** 比较两组形状，列出第一处不同。 */
function diffShapes(label, actual, expected, problems) {
  if (actual.length !== expected.length) {
    problems.push(
      `${label}: 图元数量 ${actual.length} ≠ ${expected.length}`,
    );
    return;
  }
  for (let i = 0; i < expected.length; i++) {
    const a = actual[i];
    const e = expected[i];
    for (const key of Object.keys(e)) {
      if (a[key] !== e[key]) {
        problems.push(
          `${label}[${i}].${key}: ${JSON.stringify(a[key])} ≠ ${JSON.stringify(e[key])}`,
        );
        return;
      }
    }
  }
}

async function main() {
  const worlds = findWorlds();
  if (worlds.length === 0) {
    console.log("[Smoke] 跳过 —— 仓库里没有真实世界");
    return 0;
  }

  const [modern, legacy] = await Promise.all([loadNew(), loadLegacy()]);

  // 基准拿不到 —— 跳过整个对比，只报告「没做这项验证」。
  if (!legacy) {
    console.log("[Smoke] 跳过 —— 没有基准可比对");
    return 0;
  }

  // 两边用**同一个**文字测量。
  legacy.setStubTextMeasurer(measureText);

  let totalProblems = 0;

  for (const world of worlds) {
    const problems = [];

    const tmj = JSON.parse(
      await import("node:fs").then((fs) =>
        fs.readFileSync(world.tmjPath, "utf-8"),
      ),
    );

    // 世界配置（点位、中心区域 id 都住在这里）。
    //
    // 不喂的话两边都拿不到点位 —— 中心区域点位图层会是空的，
    // 那时候「两边都空」反而掩盖了「点位真的对不对」。
    const worldConfigPath = join(
      dirname(world.tmjPath),
      "..",
      "config",
      "world.json",
    );
    const worldConfig = existsSync(worldConfigPath)
      ? JSON.parse(
          await import("node:fs").then((fs) =>
            fs.readFileSync(worldConfigPath, "utf-8"),
          ),
        )
      : {};

    // 新旧各自建一份地图数据层。
    const legacyMap = new legacy.MapManager();
    const modernMap = new modern.MapManager();
    legacyMap.loadFromTiledJSON(tmj);
    modernMap.loadFromTiledJSON(tmj);

    // 两边喂**同一份**点位数据。
    const mainAreaPoints = worldConfig.mainAreaPoints ?? [];
    legacyMap.setMainAreaPoints(mainAreaPoints);
    modernMap.setMainAreaPoints(mainAreaPoints);

    // 相机参数 —— 两边喂**同一台**。
    const camera = {
      width: 800,
      height: 600,
      zoom: 0.75,
      scrollX: 400,
      scrollY: 300,
    };

    const legacyScene = new legacy.WorldScene();
    legacyScene.mapManager = legacyMap;
    legacyScene.cameras.main.zoom = camera.zoom;
    legacyScene.cameras.main.width = camera.width;
    legacyScene.cameras.main.height = camera.height;
    legacyScene.cameras.main.scrollX = camera.scrollX;
    legacyScene.cameras.main.scrollY = camera.scrollY;
    legacyScene.cameras.main.preRender();

    const contractCamera = {
      scrollX: legacyScene.cameras.main.worldView.x,
      scrollY: legacyScene.cameras.main.worldView.y,
      zoom: camera.zoom,
      viewportX: 0,
      viewportY: 0,
      viewportWidth: legacyScene.cameras.main.worldView.width,
      viewportHeight: legacyScene.cameras.main.worldView.height,
      mapWidth: modernMap.gridWidth * modernMap.tileSize,
      mapHeight: modernMap.gridHeight * modernMap.tileSize,
    };

    /* ── 覆盖层逐层对比 ─────────────────────────────────────── */

    /**
     * 老实现的四种覆盖层**返回类型不一样**：
     *
     * - `buildWalkableOverlay()` → Graphics（没有子对象）
     * - `buildRegionBoundsOverlay()` → Container（graphics + 各个 Text）
     * - `buildMainAreaPointsOverlay()` → Graphics
     * - `buildInteractiveObjectsOverlay()` → Container（graphics + 各个 Text）
     *
     * 所以图形和文字要分开取。
     */
    const overlays = [
      {
        name: "可行走区域",
        legacy: () => legacyScene.buildWalkableOverlay(),
        toggle: "walkable",
        layerId: "walkable-overlay",
        kind: "graphics",
      },
      {
        name: "区域框",
        legacy: () => legacyScene.buildRegionBoundsOverlay(),
        toggle: "regionBounds",
        layerId: "region-bounds",
        kind: "container",
      },
      {
        name: "中心区域点位",
        legacy: () => legacyScene.buildMainAreaPointsOverlay(),
        toggle: "mainAreaPoints",
        layerId: "main-area-points",
        kind: "graphics",
      },
      {
        name: "可交互物件",
        legacy: () => legacyScene.buildInteractiveObjectsOverlay(),
        toggle: "interactiveObjects",
        layerId: "interactive-objects",
        kind: "container",
      },
    ];

    for (const overlay of overlays) {
      const legacyResult = overlay.legacy();
      const legacyGraphics =
        overlay.kind === "graphics" ? legacyResult : legacyResult.list[0];
      const legacyTexts =
        overlay.kind === "graphics" ? [] : legacyResult.list.slice(1);

      const scene = modern.buildRenderScene({
        map: modernMap,
        camera: contractCamera,
        background: {
          source: "world-base",
          width: modernMap.gridWidth * modernMap.tileSize,
          height: modernMap.gridHeight * modernMap.tileSize,
        },
        characters: [],
        overlays: { [overlay.toggle]: true },
        measureText,
      });

      const layer = scene.layers.find((l) => l.id === overlay.layerId);
      // **空图层不产出** —— 契约层不会产出一个空的图层。
      // 所以「老实现也空」时，这里不该算差异。
      //
      // 「空」的判断只看**几何操作**（fillRect / strokeRect / fillCircle…）——
      // `fillStyle` / `strokeStyle` 这类样式调用即使没有图形也会被记下来，
      // 数它们会把「什么都没画」误判成「有内容」。
      const legacyOpCount = legacyGraphics.ops.filter(
        (op) => op.op !== "fillStyle" && op.op !== "lineStyle",
      ).length;
      if (!layer) {
        if (legacyOpCount === 0 && legacyTexts.length === 0) continue;
        problems.push(`${overlay.name}: 新实现没有产出图层（老实现有内容）`);
        continue;
      }

      // 文字标签在**独立的 `labels` 层**（区域名 + 物件名合在一起）。
      const labelsLayer = scene.layers.find((l) => l.id === "labels");

      // 矩形 / 圆：几何。
      const legacyRects = legacyGraphics.ops.filter(
        (op) => op.op === "fillRect" || op.op === "strokeRect",
      );
      const modernRects = layer.items.filter(
        (item) => item.kind === "rect" && (item.fill || item.stroke),
      );
      diffShapes(
        `${overlay.name}: 矩形`,
        shapeOf(modernRects),
        shapeOf(
          legacyRects.map((op) => ({
            kind: "rect",
            x: op.args[0],
            y: op.args[1],
            width: op.args[2],
            height: op.args[3],
          })),
        ),
        problems,
      );

      // 圆：中心区域点位。
      // 老实现每个点画三个圆：`fillCircle(6)` + `strokeCircle(6)` + `fillCircle(2)`。
      // `strokeCircle` 也是「一个圆」—— 漏掉它，计数就不对。
      const legacyCircles = legacyGraphics.ops.filter(
        (op) => op.op === "fillCircle" || op.op === "strokeCircle",
      );
      if (legacyCircles.length > 0) {
        const modernCircles = layer.items.filter((item) => item.kind === "ellipse");
        diffShapes(
          `${overlay.name}: 圆`,
          shapeOf(modernCircles),
          shapeOf(
            legacyCircles.map((op) => ({
              kind: "ellipse",
              x: op.args[0],
              y: op.args[1],
              radiusX: op.args[2],
              radiusY: op.args[2],
            })),
          ),
          problems,
        );
      }

      // 文字标签：位置 + 内容 + 尺寸。
      // 新实现把区域名和物件名放在**同一个 `labels` 层**，
      // 顺序是「先区域名，后物件名」——
      // 只有同时开两个覆盖层时才会有两类标签，
      // 这里每次只开一个，所以直接取整个 labels 层。
      const modernTexts = (labelsLayer?.items ?? []).filter(
        (item) => item.kind === "text",
      );
      if (legacyTexts.length > 0 || modernTexts.length > 0) {
        diffShapes(
          `${overlay.name}: 标签`,
          shapeOf(modernTexts),
          shapeOf(
            legacyTexts.map((t) => ({
              kind: "text",
              x: t.x,
              y: t.y,
              width: t.width,
              height: t.height,
              content: t.content,
            })),
          ),
          problems,
        );
      }
    }

    if (problems.length === 0) {
      console.log(
        `[Smoke] ✓ ${world.name}: ` +
          `网格 ${modernMap.gridWidth}×${modernMap.gridHeight}@${modernMap.tileSize}px, ` +
          `区域 ${modernMap.locations.size} 个, 物件 ${modernMap.interactiveObjects.size} 个`,
      );
    } else {
      totalProblems += problems.length;
      console.log(`[Smoke] ✗ ${world.name}:`);
      for (const p of problems) console.log(`  ${p}`);
    }
  }

  if (totalProblems > 0) {
    console.log(`\n[Smoke] 失败：${totalProblems} 处差异`);
    return 1;
  }

  console.log("\n[Smoke] 全部一致");
  return 0;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    console.error("[Smoke] 错误:", err);
    process.exit(1);
  });
