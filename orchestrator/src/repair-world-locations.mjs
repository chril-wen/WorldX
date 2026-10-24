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
 *   2. world.json 里除 main_area 外的 location，都要有对应的 TMJ region
 *      （没有对应区域的 location 是历史残留，会让角色去到地图上不存在的地方）
 *   3. main_area 允许没有 TMJ region（它是「公共枢纽」概念）
 *   4. 顺带用规范算法重建 mainAreaPoints（命名 + 邻接关系）
 *
 * 运行：node orchestrator/src/repair-world-locations.mjs <worldDir> [--dry-run]
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { buildMainAreaPoints } from "./main-area-points.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
export function repairWorld(worldDir, { dryRun = false } = {}) {
  const mapDir = join(worldDir, "map");
  const tmjPath = join(mapDir, "06-final.tmj");
  const configPath = join(worldDir, "config", "world.json");

  if (!existsSync(tmjPath)) throw new Error("TMJ not found: " + tmjPath);
  if (!existsSync(configPath)) throw new Error("world.json not found: " + configPath);

  const tmj = readJSON(tmjPath);
  const worldConfig = readJSON(configPath);

  const notes = [];
  const regionsLayer = tmj.layers.find((l) => l.name === "regions");
  const objectsLayer = tmj.layers.find((l) => l.name === "interactive_objects");
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
        adjacentLocations: ["main_area"],
        objects: [],
        ...(props.regionType ? { indoor: props.regionType === "building" } : {}),
      });
    }
  }

  // ── 2. 保留 main_area 与其它没有对应 TMJ region 的 location ───────────────
  for (const location of existingLocations) {
    if (consumedLocations.has(location.id)) continue;
    if (seenIds.has(location.id)) continue;
    if (location.id === "main_area") {
      nextLocations.unshift(location);
      continue;
    }
    notes.push(
      "location「" + location.name + "」(" + location.id +
      ") 在 TMJ 里没有对应区域，地图上并不存在，已移除",
    );
  }

  // ── 3. 邻接关系：main_area 连到所有新区域 ──────────────────────────────────
  const nextIds = new Set(nextLocations.map((l) => l.id));
  for (const location of nextLocations) {
    if (location.id === "main_area") continue;
    const adjacent = Array.isArray(location.adjacentLocations)
      ? location.adjacentLocations.filter((id) => id === "main_area" || nextIds.has(id))
      : [];
    if (!adjacent.includes("main_area")) adjacent.unshift("main_area");
    location.adjacentLocations = Array.from(new Set(adjacent));
  }

  // ── 4. 重建主区域点位（命名 + 邻接关系） ───────────────────────────────────
  const collisionLayer = tmj.layers.find((l) => l.name === "collision");
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
    const { notes } = repairWorld(worldDir, { dryRun });
    console.log(dryRun ? "[Repair] Dry run:" : "[Repair] Fixed:");
    for (const note of notes) console.log("  - " + note);
  } catch (err) {
    console.error("[Repair] Error:", err.message);
    process.exit(1);
  }
}
