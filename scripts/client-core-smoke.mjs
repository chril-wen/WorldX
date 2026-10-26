/**
 * 冒烟脚本 —— 真实世界的 TMJ 解析，新旧实现逐字段对比。
 *
 * ## 为什么要有这个
 *
 * `ab-comparison.test.ts` 用的是**人造地图**。人造地图只覆盖了我们想到的情况；
 * 真实世界的 TMJ 有各种怪东西 —— 额外的层、缺失的层、properties 里的
 * 意外类型、区域名带中文、物件 id 跟区域 id 撞名。
 *
 * 这个脚本拿**仓库里真实存在的世界**跑一遍，逐字段对比新旧实现。
 *
 * ## 怎么用
 *
 *     node scripts/client-core-smoke.mjs
 *
 * 退出码 0 = 全部一致；非 0 = 有差异（会打印具体差在哪）。
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

/**
 * 改造前的解析实现 —— 从 git 里按原样取出。
 *
 * 跟 `packages/client-core/src/ab-comparison.test.ts` 用的是同一份基准。
 * 这个脚本面向**真实世界**，那个测试面向**人造地图**。
 */
const LEGACY_DIR = join(ROOT, ".legacy-baseline");

/** 找到仓库里所有真实世界 */
function findWorlds() {
  const worlds = [];
  for (const base of [join(ROOT, "output", "worlds"), join(ROOT, "library", "worlds")]) {
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const tmjPath = join(base, entry.name, "map", "06-final.tmj");
      if (existsSync(tmjPath)) {
        worlds.push({ name: entry.name, dir: join(base, entry.name), tmjPath });
      }
    }
  }
  return worlds;
}

/** 加载 core 的解析器（源码，走 tsx） */
async function loadCoreParser() {
  const corePath = join(ROOT, "packages", "core", "src", "engine", "tmj-parser.ts");
  const { tsImport } = await import("tsx/esm/api");
  return tsImport(pathToFileURL(corePath).href, import.meta.url);
}

/** 加载改造前的 MapManager */
async function loadLegacyMapManager() {
  const legacyPath = join(LEGACY_DIR, "MapManager.ts");
  const { tsImport } = await import("tsx/esm/api");
  const mod = await tsImport(pathToFileURL(legacyPath).href, import.meta.url);
  return mod.MapManager;
}

/** 加载新的 MapManager */
async function loadNewMapManager() {
  const corePath = join(ROOT, "packages", "core", "src", "engine", "tmj-parser.ts");
  const clientCorePath = join(
    ROOT,
    "packages",
    "client-core",
    "src",
    "map-model.ts",
  );
  const { tsImport } = await import("tsx/esm/api");
  const [core, clientCore] = await Promise.all([
    tsImport(pathToFileURL(corePath).href, import.meta.url),
    tsImport(pathToFileURL(clientCorePath).href, import.meta.url),
  ]);
  // map-model 依赖 @own-world/core —— 用 core 的源码满足它
  return { MapManager: clientCore.MapManager, core };
}

/** 把 MapManager 的解析结果摊成可比对的纯数据 */
function snapshot(mapManager) {
  return {
    gridWidth: mapManager.gridWidth,
    gridHeight: mapManager.gridHeight,
    tileSize: mapManager.tileSize,
    collisionGrid: mapManager.collisionGrid,
    locations: [...mapManager.locations.entries()].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    ),
    interactiveObjects: [...mapManager.interactiveObjects.entries()].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    ),
  };
}

/** 深比较，返回差异描述列表 */
function diff(label, a, b) {
  const problems = [];
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  if (ja === jb) return problems;

  // 逐字段定位差异，比整坨 JSON 好读
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      const sa = JSON.stringify(a[key]);
      const sb = JSON.stringify(b[key]);
      if (sa !== sb) {
        const short = (s) => (s && s.length > 120 ? s.slice(0, 120) + "…" : s);
        problems.push(`  ${label}.${key}:`);
        problems.push(`    旧: ${short(sa)}`);
        problems.push(`    新: ${short(sb)}`);
      }
    }
    if (problems.length === 0) {
      problems.push(`  ${label}: 整体不同（结构不匹配）`);
    }
    return problems;
  }

  problems.push(`  ${label}: 旧=${JSON.stringify(a)} 新=${JSON.stringify(b)}`);
  return problems;
}

async function main() {
  const worlds = findWorlds();
  if (worlds.length === 0) {
    console.log("[Smoke] 没找到任何真实世界 —— 跳过");
    console.log("[Smoke] 需要 output/worlds/ 或 library/worlds/ 下有 06-final.tmj");
    return 0;
  }

  console.log(`[Smoke] 找到 ${worlds.length} 个真实世界`);

  const [coreParser, LegacyMapManager, { MapManager: NewMapManager }] = await Promise.all([
    loadCoreParser(),
    loadLegacyMapManager(),
    loadNewMapManager(),
  ]);

  let totalProblems = 0;

  for (const world of worlds) {
    const raw = readFileSync(world.tmjPath, "utf-8");
    const tmj = JSON.parse(raw);

    const legacy = new LegacyMapManager();
    const modern = new NewMapManager();

    // 屏蔽 console.log —— MapManager 加载时会打日志
    const originalLog = console.log;
    console.log = () => {};
    try {
      legacy.loadFromTiledJSON(tmj);
      modern.loadFromTiledJSON(tmj);
    } finally {
      console.log = originalLog;
    }

    const problems = [
      ...diff("gridWidth", legacy.gridWidth, modern.gridWidth),
      ...diff("gridHeight", legacy.gridHeight, modern.gridHeight),
      ...diff("tileSize", legacy.tileSize, modern.tileSize),
      ...diff("collisionGrid", legacy.collisionGrid, modern.collisionGrid),
      ...diff("locations", snapshot(legacy).locations, snapshot(modern).locations),
      ...diff(
        "interactiveObjects",
        snapshot(legacy).interactiveObjects,
        snapshot(modern).interactiveObjects,
      ),
    ];

    // 顺便用 core 的解析器核对一下 TMJ 的基本事实
    const parsed = coreParser.parseTmj(tmj);
    const layerCount = Array.isArray(tmj.layers) ? tmj.layers.length : 0;

    if (problems.length === 0) {
      console.log(
        `[Smoke] ✓ ${world.name}: ` +
          `网格 ${modern.gridWidth}×${modern.gridHeight}@${modern.tileSize}px, ` +
          `区域 ${modern.locations.size} 个, 物件 ${modern.interactiveObjects.size} 个, ` +
          `TMJ ${layerCount} 层`,
      );
    } else {
      totalProblems += problems.length;
      console.log(`[Smoke] ✗ ${world.name}:`);
      for (const p of problems) console.log(p);
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
