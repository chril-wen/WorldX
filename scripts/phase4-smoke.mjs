#!/usr/bin/env node
/**
 * 阶段 4 冒烟 —— 「世界中心改名后，行为跟着改」。
 *
 * ## 验的是什么
 *
 * 阶段 4 把「中心区域叫 main_area」这个写死的假设，
 * 换成了 world.json 声明的 `centerLocationId`。
 *
 * 单元测试证明「代码读的是配置」，但没证明**运行时**真的按配置走。
 * 这个冒烟走**真实链路**：
 *
 *   server 的 config-loader 读真 world.json
 *     → WorldManager
 *     → CharacterManager
 *     → 角色真的落在中心区域、真的在中心区域里移动
 *
 * 不是拿 core 的假 config source 糊弄 —— 那样只能证明 core 内部自洽，
 * 证明不了「world.json 改了真的会生效」。
 *
 * ## 两条要验的
 *
 * 1. **默认路径**：不改任何东西，角色照旧落在 "main_area"，
 *    照旧在主区域里用点位移动（行为 100% 不变）
 * 2. **改名场景**：把中心区域改成 "town_square"，
 *    角色跟着落到 town_square —— 改造前这里是**静默失效**的
 *
 * 用法：node scripts/phase4-smoke.mjs [--world <worldId>]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, "..");
const SERVER_DEPS = (spec) =>
  pathToFileURL(path.join(PROJECT_DIR, "server", "node_modules", spec)).href;

const CORE_ENTRY = path.join(PROJECT_DIR, "packages", "core", "dist", "index.js");

const { WorldManager, CharacterManager } = await import(
  pathToFileURL(CORE_ENTRY).href
);
const { filesystemConfigSource } = await import(
  SERVER_DEPS(path.join("../dist/store/config-source.js"))
);
const { createDefaultStorage } = await import(
  SERVER_DEPS(path.join("../dist/store/storage-adapter.js"))
);
const { initDatabase, closeDb } = await import(
  SERVER_DEPS(path.join("../dist/store/db.js"))
);

// 每个场景一个独立的临时库 —— 角色状态存在 SQLite 里，
// 共用同一个库的话第二个场景会读到第一个场景写进去的状态。
const tmpDbs = [];
function freshDb() {
  const dbPath = path.join(
    os.tmpdir(),
    `worldx-phase4-smoke-${Date.now()}-${tmpDbs.length}.db`,
  );
  tmpDbs.push(dbPath);
  initDatabase(dbPath);
  return dbPath;
}

const GENERATED_WORLDS_DIR = path.join(PROJECT_DIR, "output", "worlds");
const LIBRARY_WORLDS_DIR = path.join(PROJECT_DIR, "library", "worlds");

const args = process.argv.slice(2);
const worldArgIndex = args.indexOf("--world");
const worldId =
  worldArgIndex >= 0 && args[worldArgIndex + 1]
    ? args[worldArgIndex + 1]
    : null;

function listWorldDirs() {
  const out = [];
  for (const base of [GENERATED_WORLDS_DIR, LIBRARY_WORLDS_DIR]) {
    if (!fs.existsSync(base)) continue;
    for (const name of fs.readdirSync(base)) {
      const dir = path.join(base, name);
      if (
        fs.existsSync(path.join(dir, "world.json")) ||
        fs.existsSync(path.join(dir, "config", "world.json"))
      ) {
        out.push(dir);
      }
    }
  }
  return out;
}

function resolveWorldDir() {
  const dirs = listWorldDirs();
  if (worldId) {
    const found = dirs.find((d) => path.basename(d) === worldId);
    if (!found) throw new Error(`找不到世界：${worldId}`);
    return found;
  }
  const generated = dirs.filter((d) => d.startsWith(GENERATED_WORLDS_DIR));
  const pool = generated.length > 0 ? generated : dirs;
  pool.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (pool.length === 0) throw new Error("没有任何世界");
  return pool[0];
}

function worldJsonPath(worldDir) {
  for (const p of [
    path.join(worldDir, "world.json"),
    path.join(worldDir, "config", "world.json"),
  ]) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`${worldDir} 里没有 world.json`);
}

let failures = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}`);
    console.log(`      实际: ${a}`);
    console.log(`      期望: ${b}`);
    failures++;
  }
}

const worldDir = resolveWorldDir();
const configPath = worldJsonPath(worldDir);
console.log(`=== 阶段 4 冒烟：${path.basename(worldDir)} ===\n`);

// ── 1. 默认路径：行为 100% 不变 ──────────────────────────────────────────

console.log("■ 默认路径（world.json 没声明中心区域）");
{
  freshDb();
  const storage = createDefaultStorage();
  filesystemConfigSource.setWorldDir(worldDir);
  const wm = new WorldManager(filesystemConfigSource, storage);
  wm.initialize();
  const cm = new CharacterManager(wm, storage, filesystemConfigSource);
  cm.initialize();

  check("中心区域 id 是 main_area", wm.getCenterLocationId(), "main_area");
  check(
    "中心区域在 locations 里",
    wm.getLocations().some((l) => l.id === "main_area"),
    true,
  );
  check(
    "中心区域连到所有其它区域",
    wm.getAdjacentLocations("main_area").length,
    wm.getLocations().filter((l) => l.id !== "main_area").length,
  );

  // 角色：落在中心区域，且有 mainAreaPointId（点位寻址）
  const states = cm.getAllStates();
  check("至少有一个角色", states.length > 0, true);
  const inCenter = states.filter((s) => s.location === "main_area");
  check("角色落在中心区域", inCenter.length > 0, true);
  check(
    "中心区域里的角色有 mainAreaPointId（点位寻址）",
    inCenter.every((s) => !!s.mainAreaPointId),
    true,
  );
  console.log("");
}

// ── 2. 改名场景：中心区域叫 town_square ──────────────────────────────────

console.log("■ 改名场景（中心区域改成 town_square）");
{
  // 造一份临时 world.json —— 不碰真实世界的磁盘文件。
  const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  const TMP_WORLD_DIR = path.join(
    os.tmpdir(),
    `worldx-phase4-smoke-world-${Date.now()}`,
  );
  fs.mkdirSync(TMP_WORLD_DIR, { recursive: true });
  fs.cpSync(worldDir, TMP_WORLD_DIR, { recursive: true });

  const tmpConfigPath = path.join(TMP_WORLD_DIR, "config", "world.json");
  if (!fs.existsSync(path.dirname(tmpConfigPath))) {
    fs.mkdirSync(path.dirname(tmpConfigPath), { recursive: true });
  }
  // 把中心区域改名：locations 里的 id 和 adjacentLocations 里的引用一起改
  const NEW_CENTER = "town_square";
  const renamed = {
    ...raw,
    centerLocationId: NEW_CENTER,
    locations: (raw.locations || []).map((l) => ({
      ...l,
      id: l.id === "main_area" ? NEW_CENTER : l.id,
      adjacentLocations: (l.adjacentLocations || []).map((a) =>
        a === "main_area" ? NEW_CENTER : a,
      ),
    })),
  };
  fs.writeFileSync(tmpConfigPath, JSON.stringify(renamed, null, 2));

  // 角色配置里的 startPosition.locationId 也是**具体 id 引用** ——
  // 世界中心改名，它也得跟着改，否则角色会落在不存在的地方。
  // （这跟「代码里写死 main_area」是两回事：这里是数据引用，改名就该跟着改。）
  const charsDir = path.join(TMP_WORLD_DIR, "config", "characters");
  if (fs.existsSync(charsDir)) {
    for (const file of fs.readdirSync(charsDir).filter((f) => f.endsWith(".json"))) {
      const cp = path.join(charsDir, file);
      const charRaw = JSON.parse(fs.readFileSync(cp, "utf-8"));
      // startPosition 有两种形态：字符串，或带 locationId 的对象。
      if (charRaw?.startPosition === "main_area") {
        charRaw.startPosition = NEW_CENTER;
      } else if (charRaw?.startPosition?.locationId === "main_area") {
        charRaw.startPosition.locationId = NEW_CENTER;
      }
      if (Array.isArray(charRaw?.preferredLocations)) {
        charRaw.preferredLocations = charRaw.preferredLocations.map((l) =>
          l === "main_area" ? NEW_CENTER : l,
        );
      }
      fs.writeFileSync(cp, JSON.stringify(charRaw, null, 2));
    }
  }

  freshDb();
  const storage = createDefaultStorage();
  filesystemConfigSource.setWorldDir(TMP_WORLD_DIR);
  const wm = new WorldManager(filesystemConfigSource, storage);
  wm.initialize();
  const cm = new CharacterManager(wm, storage, filesystemConfigSource);
  cm.initialize();

  check("中心区域 id 是 town_square", wm.getCenterLocationId(), NEW_CENTER);
  check(
    "没有残留 main_area",
    wm.getLocations().some((l) => l.id === "main_area"),
    false,
  );
  check(
    "town_square 连到所有其它区域",
    wm.getAdjacentLocations(NEW_CENTER).length,
    wm.getLocations().filter((l) => l.id !== NEW_CENTER).length,
  );

  const states = cm.getAllStates();
  const inCenter = states.filter((s) => s.location === NEW_CENTER);
  check("角色落在 town_square", inCenter.length > 0, true);
  check(
    "town_square 里的角色有 mainAreaPointId",
    inCenter.every((s) => !!s.mainAreaPointId),
    true,
  );
  const stillInMainArea = states.filter((s) => s.location === "main_area");
  check(
    "没有角色还留在 main_area",
    stillInMainArea.length,
    0,
  );
  if (stillInMainArea.length > 0) {
    for (const st of stillInMainArea) {
      const prof = cm.getProfile(st.characterId);
      console.log(
        `      → ${prof?.name} (${st.characterId}) startPosition=${JSON.stringify(prof?.startPosition)}`,
      );
    }
  }

  fs.rmSync(TMP_WORLD_DIR, { recursive: true, force: true });
  console.log("");
}

closeDb();
console.log("=== 结果 ===");
if (failures === 0) {
  console.log("全部通过 ✅ —— 默认路径行为不变，改名场景跟着改。");
  process.exit(0);
} else {
  console.log(`${failures} 项失败 ❌`);
  process.exit(1);
}
