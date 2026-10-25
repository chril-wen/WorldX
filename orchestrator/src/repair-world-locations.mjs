/**
 * repair-world-locations.mjs
 * 修复世界配置里 TMJ 与 world.json 的区域 id 不一致问题。
 *
 * 为什么需要：
 *   客户端（MapManager）从 TMJ 的 regions 图层读区域，
 *   服务端（WorldManager）从 world.json 的 locations 读地点。
 *   两边 id 对不上就会出现「看得见但用不了」的区域——
 *   角色在服务端找不到这个地点，客户端却能点进去。
 *
 * 修复规则（TMJ 是地图布局的权威来源）：
 *   1. TMJ 里每个 region，都要在 world.json 里有一个同 id 的 location
 *   2. world.json 里除中心区域外的 location，都要有对应的 TMJ region
 *      （没有对应区域的 location 是历史残留，会让角色去到地图上不存在的地方）
 *   3. 中心区域允许没有 TMJ region（它是「公共枢纽」概念）
 *   4. 顺带用规范算法重建 mainAreaPoints（命名 + 邻接关系）
 *
 * 运行：node orchestrator/src/repair-world-locations.mjs <worldDir> [--dry-run]
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { buildMainAreaPoints } from "./main-area-points.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * 加载 core 的 world.json 迁移函数。
 *
 * 走 tsx 吃 core **源码** —— 跟 vitest、跟 config-generator 走的是同一份逻辑，
 * 不用先 build core，也不会用到旧的 dist。
 */

/**
 * core 的 TMJ 层查找 —— 由 `loadMigrate()` 填充。
 *
 * 声明必须在 `loadMigrate` **之前** —— 否则赋值那一行会撞上 TDZ。
 */
let findTmjLayer = null;

let migrateCache;
async function loadMigrate() {
  if (migrateCache !== undefined) return migrateCache;
  const corePath = join(
    __dirname,
    "..",
    "..",
    "packages",
    "core",
    "src",
    "engine",
    "world-migration.ts",
  );
  const tmjParserPath = join(
    __dirname,
    "..",
    "..",
    "packages",
    "core",
    "src",
    "engine",
    "tmj-parser.ts",
  );
  try {
    const { tsImport } = await import("tsx/esm/api");
    const [mod, tmjParser] = await Promise.all([
      tsImport(pathToFileURL(corePath).href, import.meta.url),
      tsImport(pathToFileURL(tmjParserPath).href, import.meta.url),
    ]);
    migrateCache = mod.migrateWorldConfig;
    // TMJ 解析器 —— 全仓唯一的一份（改造前这里也自己写了一遍层查找）。
    findTmjLayer = tmjParser.findTmjLayer;
  } catch (err) {
    throw new Error(
      `[Repair] 加载 core 的迁移函数失败（${corePath}）：${err?.message ?? err}`,
    );
  }
  return migrateCache;
}


function readJSON(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function getProps(obj) {
  const props = {};
  for (const p of obj.properties || []) props[p.name] = p.value;
  return props;
}

/**
 * 修复单个世界。
 * @returns {{changed: boolean, notes: string[]}}
 */
export async function repairWorld(worldDir, { dryRun = false } = {}) {
  const mapDir = join(worldDir, "map");
  const tmjPath = join(mapDir, "06-final.tmj");
  const configPath = join(worldDir, "config", "world.json");

  if (!existsSync(tmjPath)) throw new Error("TMJ not found: " + tmjPath);
  if (!existsSync(configPath)) throw new Error("world.json not found: " + configPath);

  const tmj = readJSON(tmjPath);
  const migrateWorldConfig = await loadMigrate();
  // 先过迁移 —— 拿到世界自己声明的中心区域 id。
  // 旧世界没有这个字段，迁移函数补默认值（"main_area"）。
  const worldConfig = migrateWorldConfig(readJSON(configPath));
  const centerLocationId = worldConfig.centerLocationId;

  const notes = [];
  const regionsLayer = findTmjLayer(tmj, "regions");
  const objectsLayer = findTmjLayer(tmj, "interactive_objects");
  const tmjRegions = regionsLayer?.objects || [];
  const tmjObjects = objectsLayer?.objects || [];

  const existingLocations = Array.isArray(worldConfig.locations) ? worldConfig.locations : [];
  const byId = new Map(existingLocations.map((l) => [l.id, l]));
  const byName = new Map(existingLocations.map((l) => [l.name, l]));
  /** 已经被某个 TMJ region 认领走的 location，避免后面被误判为「多余」 */
  const consumedLocations = new Set();

  // ── 1. 为每个 TMJ region 建立/补齐 location ───────────────────────────────
  const nextLocations = [];
  const seenIds = new Set();

  for (const region of tmjRegions) {
    const props = getProps(region);
    const regionId = props.id || region.name;
    if (seenIds.has(regionId)) continue;
    seenIds.add(regionId);

    // 优先按 id 匹配，其次按名称匹配（视觉模型可能改过 id）
    let existing = byId.get(regionId);
    let renamed = false;
    if (!existing) {
      const byNameMatch = byName.get(region.name);
      if (byNameMatch && !consumedLocations.has(byNameMatch.id)) {
        existing = byNameMatch;
        renamed = true;
        notes.push(
          "region「" + region.name + "」id 不一致：TMJ=" + regionId +
          " / world.json=" + existing.id + "，以 TMJ 为准",
        );
      }
    }

    if (existing) {
      consumedLocations.add(existing.id);
      const location = { ...existing, id: regionId, name: region.name || existing.name };
      // TMJ 里有描述就补上（视觉解析常常不带描述）
      if (!location.description && props.description) {
        location.description = props.description;
      }
      if (location.indoor === undefined && props.regionType) {
        location.indoor = props.regionType === "building";
      }
      nextLocations.push(location);
    } else {
      notes.push("region「" + region.name + "」在 world.json 中缺失，已新建");
      nextLocations.push({
        id: regionId,
        name: region.name || regionId,
        description: props.description || "",
        adjacentLocations: [centerLocationId],
        objects: [],
        ...(props.regionType ? { indoor: props.regionType === "building" } : {}),
      });
    }
  }

  // ── 2. 保留中心区域与其它没有对应 TMJ region 的 location ─────────────────
  for (const location of existingLocations) {
    if (consumedLocations.has(location.id)) continue;
    if (seenIds.has(location.id)) continue;
    if (location.id === centerLocationId) {
      nextLocations.unshift(location);
      continue;
    }
    notes.push(
      "location「" + location.name + "」(" + location.id +
      ") 在 TMJ 里没有对应区域，地图上并不存在，已移除",
    );
  }

  // ── 3. 邻接关系：中心区域连到所有新区域 ────────────────────────────────────
  const nextIds = new Set(nextLocations.map((l) => l.id));
  for (const location of nextLocations) {
    if (location.id === centerLocationId) continue;
    const adjacent = Array.isArray(location.adjacentLocations)
      ? location.adjacentLocations.filter(
          (id) => id === centerLocationId || nextIds.has(id),
        )
      : [];
    if (!adjacent.includes(centerLocationId)) adjacent.unshift(centerLocationId);
    location.adjacentLocations = Array.from(new Set(adjacent));
  }

  // 中心区域要连到**所有**其它区域。
  //
  // 上面只保证了「每个区域 → 中心」，没保证「中心 → 每个区域」。
  // 少了这半边，新建的 location 就是单向可达的：
  // 角色在 main_area 看不到「镇心集市」这个选项，走不进去。
  //
  // 这跟 `core` 的 `normalizeLocations` 是同一个规则 ——
  // 「中心区域连到所有真实区域，它是星形拓扑的中心」。
  const center = nextLocations.find((l) => l.id === centerLocationId);
  if (center) {
    const others = nextLocations
      .map((l) => l.id)
      .filter((id) => id !== centerLocationId);
    center.adjacentLocations = Array.from(
      new Set([...(center.adjacentLocations || []), ...others]),
    ).filter((id) => nextIds.has(id));
  }

  // ── 4. 重建主区域点位（命名 + 邻接关系） ───────────────────────────────────
  const collisionLayer = findTmjLayer(tmj, "collision");
  const points = buildMainAreaPoints({
    tmj,
    collisionLayer,
    regions: tmjRegions,
    elementObjects: tmjObjects,
  });
  const oldPointCount = Array.isArray(worldConfig.mainAreaPoints)
    ? worldConfig.mainAreaPoints.length
    : 0;
  notes.push(
    "主区域点位：" + oldPointCount + " -> " + points.length +
    "（带命名与邻接关系）",
  );

  worldConfig.locations = nextLocations;
  worldConfig.mainAreaPoints = points;

  if (!dryRun) {
    writeFileSync(configPath, JSON.stringify(worldConfig, null, 2), "utf-8");
  }

  return { changed: true, notes };
}

// ─── CLI ────────────────────────────────────────────────────────────────────

if (process.argv[1]?.endsWith("repair-world-locations.mjs")) {
  const worldDir = process.argv[2];
  const dryRun = process.argv.includes("--dry-run");
  if (!worldDir) {
    console.error("Usage: node repair-world-locations.mjs <worldDir> [--dry-run]");
    process.exit(1);
  }
  try {
    const { notes } = await repairWorld(worldDir, { dryRun });
    console.log(dryRun ? "[Repair] Dry run:" : "[Repair] Fixed:");
    for (const note of notes) console.log("  - " + note);
  } catch (err) {
    console.error("[Repair] Error:", err.message);
    process.exit(1);
  }
}
