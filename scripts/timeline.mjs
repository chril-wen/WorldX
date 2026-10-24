#!/usr/bin/env node
/**
 * 时间线状态工具 —— 快照 / 分叉 / 对比。
 *
 * 直接操作文件系统，不依赖 server 在跑。
 *
 * 用法：
 *   npm run timeline -- list [--world <worldId>]
 *   npm run timeline -- snapshots <timelineId> [--world <worldId>]
 *   npm run timeline -- snapshot <timelineId> [--desc "..."] [--world <worldId>]
 *   npm run timeline -- fork <timelineId> <snapshotId> [--label "..."] [--world <worldId>]
 *   npm run timeline -- diff <timelineA> <timelineB> [--world <worldId>]
 *
 * 不传 --world 时用「当前世界」= 最近生成的那个世界目录。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, "..");
// server 的依赖（better-sqlite3 等）装在 server/node_modules，
// 从 scripts/ 里 import 解析不到 —— 显式指到 server 目录。
const SERVER_DEPS = (spec) =>
  pathToFileURL(path.join(PROJECT_DIR, "server", "node_modules", spec)).href;
// 包目录要指到带 package.json 的那一层，Node 才认得出 main 入口
const SERVER_PKG = (name) => {
  const pkgPath = path.join(PROJECT_DIR, "server", "node_modules", name, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  return pathToFileURL(
    path.join(PROJECT_DIR, "server", "node_modules", name, pkg.main ?? "index.js"),
  ).href;
};
const GENERATED_WORLDS_DIR = path.join(PROJECT_DIR, "output", "worlds");
const LIBRARY_WORLDS_DIR = path.join(PROJECT_DIR, "library", "worlds");

const args = process.argv.slice(2);

function arg(flag, fallback = null) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
}
const has = (flag) => args.includes(flag);

// ─── 找世界目录 ─────────────────────────────────────────────────────────────

function listWorldDirs() {
  const out = [];
  for (const base of [GENERATED_WORLDS_DIR, LIBRARY_WORLDS_DIR]) {
    if (!fs.existsSync(base)) continue;
    for (const name of fs.readdirSync(base)) {
      const dir = path.join(base, name);
      if (fs.existsSync(path.join(dir, "timelines"))) out.push(dir);
    }
  }
  return out;
}

function resolveWorldDir(worldId) {
  const dirs = listWorldDirs();
  if (worldId) {
    const found = dirs.find((d) => path.basename(d) === worldId);
    if (!found) throw new Error(`World not found: ${worldId}`);
    return found;
  }
  if (dirs.length === 0) throw new Error("No world with timelines found");
  // 最近的生成世界优先
  const generated = dirs.filter((d) => d.startsWith(GENERATED_WORLDS_DIR));
  const pool = generated.length > 0 ? generated : dirs;
  pool.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return pool[0];
}

// ─── 读时间线 ───────────────────────────────────────────────────────────────

function listTimelines(worldDir) {
  const dir = path.join(worldDir, "timelines");
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const metaPath = path.join(dir, name, "meta.json");
    if (!fs.existsSync(metaPath)) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(metaPath, "utf-8")));
    } catch {
      // 坏 meta 跳过
    }
  }
  out.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  return out;
}

function timelineDir(worldDir, timelineId) {
  return path.join(worldDir, "timelines", timelineId);
}

function dbPath(worldDir, timelineId) {
  return path.join(timelineDir(worldDir, timelineId), "state.db");
}

// ─── 命令 ───────────────────────────────────────────────────────────────────

function cmdList() {
  const worldDir = resolveWorldDir(arg("--world"));
  console.log(`World: ${path.basename(worldDir)}  (${worldDir})\n`);
  const timelines = listTimelines(worldDir);
  if (timelines.length === 0) {
    console.log("(没有时间线)");
    return;
  }
  for (const t of timelines) {
    const fork = t.forkedFrom
      ? `  ← 分叉自 ${t.forkedFrom.timelineId} @ day ${t.forkedFrom.day} tick ${t.forkedFrom.tick}`
      : "";
    const label = t.label ? `  「${t.label}」` : "";
    console.log(`${t.id}  day ${t.lastGameTime?.day} tick ${t.lastGameTime?.tick}  ${t.tickCount} 帧${label}${fork}`);
  }
}

async function cmdSnapshots() {
  const worldDir = resolveWorldDir(arg("--world"));
  const timelineId = args[1];
  if (!timelineId) throw new Error("用法：npm run timeline -- snapshots <timelineId>");

  const { default: Database } = await import(SERVER_PKG("better-sqlite3"));
  const p = dbPath(worldDir, timelineId);
  if (!fs.existsSync(p)) throw new Error(`Timeline not found: ${timelineId}`);

  const db = new Database(p, { readonly: true });
  try {
    const rows = db.prepare("SELECT * FROM snapshots ORDER BY created_at DESC").all();
    if (rows.length === 0) {
      console.log("(没有快照)");
      return;
    }
    for (const r of rows) {
      console.log(`${r.id}  day ${r.game_day} tick ${r.game_tick}  ${r.description || "(无描述)"}  ${r.created_at}`);
    }
  } finally {
    db.close();
  }
}

async function cmdSnapshot() {
  const worldDir = resolveWorldDir(arg("--world"));
  const timelineId = args[1];
  if (!timelineId) throw new Error("用法：npm run timeline -- snapshot <timelineId> [--desc \"...\"]");

  const { createTimelineSnapshot } = await import("../server/src/store/snapshot-store.ts");
  const { initDatabase, closeDb } = await import("../server/src/store/db.ts");

  const dir = timelineDir(worldDir, timelineId);
  const p = dbPath(worldDir, timelineId);
  if (!fs.existsSync(p)) throw new Error(`Timeline not found: ${timelineId}`);

  const meta = listTimelines(worldDir).find((t) => t.id === timelineId);
  const gameTime = meta?.lastGameTime ?? { day: 1, tick: 0 };
  const description = arg("--desc", `手动快照 day ${gameTime.day} tick ${gameTime.tick}`);

  initDatabase(p);
  let id;
  try {
    id = createTimelineSnapshot({ dir, dbPath: p }, gameTime, description);
  } finally {
    closeDb();
  }
  console.log(`已创建快照 ${id}（day ${gameTime.day} tick ${gameTime.tick}）`);
}

/**
 * 问 server「现在有没有模拟正在跑」。
 *
 * 恢复快照要把磁盘上的库换掉 —— 如果 server 开着，它：
 *   1) 持有 state.db 的文件句柄（Windows 上直接 EBUSY，删不掉 -wal）
 *   2) 内存里的角色状态是旧的，跟磁盘对不上
 * 所以 server 开着的时候恢复，得到的要么是失败，要么是半截状态。
 *
 * 返回 null = 连不上 server（没开），此时 CLI 是唯一持有者，可以放心恢复。
 */
async function queryServerBusy() {
  const base = process.env.SERVER_BASE_URL || "http://localhost:3100";
  try {
    const res = await fetch(`${base}/api/simulation/status`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.activeSimulationTicks === "number"
      ? data.activeSimulationTicks
      : null;
  } catch {
    // server 没在跑 —— 不知道状态
    return null;
  }
}

async function cmdRestore() {
  const worldDir = resolveWorldDir(arg("--world"));
  const timelineId = args[1];
  const snapshotId = args[2];
  if (!timelineId || !snapshotId) {
    throw new Error("用法：npm run timeline -- restore <timelineId> <snapshotId> [--force]");
  }

  const p = dbPath(worldDir, timelineId);
  if (!fs.existsSync(p)) throw new Error(`Timeline not found: ${timelineId}`);

  // 保护：server 开着就别动它的库
  const busy = await queryServerBusy();
  if (busy !== null) {
    if (!has("--force")) {
      throw new Error(
        `server 正在运行（${busy > 0 ? `${busy} 个 tick 未完成` : "空闲"}），` +
        `它的内存状态和磁盘上的库对不上，恢复会得到半截状态。\n` +
        `请先停掉 server 再恢复，或者加 --force 强制恢复。`,
      );
    }
    console.warn("警告：server 正在运行，强制恢复可能让它的内存状态不一致。");
  }

  const { TimelineManager } = await import("../server/src/services/timeline-manager.ts");
  const tm = new TimelineManager();
  // restoreToSnapshot 同时还原 DB 和事件流 —— 只还原 DB 会让回放
  // 重演「快照之后已经发生过、但状态里已经没有」的事件。
  const at = tm.restoreToSnapshot(worldDir, timelineId, snapshotId);

  console.log(`已恢复时间线 ${timelineId} 到快照 ${snapshotId}`);
  console.log(`  状态与事件流都已回退到 day ${at.day} tick ${at.tick}`);
  if (busy !== null) {
    console.log("  server 还在跑 —— 请重启它或切换时间线，让运行时重新加载状态。");
  }
}

async function cmdFork() {
  const worldDir = resolveWorldDir(arg("--world"));
  const timelineId = args[1];
  const snapshotId = args[2];
  if (!timelineId || !snapshotId) {
    throw new Error("用法：npm run timeline -- fork <timelineId> <snapshotId> [--label \"...\"]");
  }

  const { TimelineManager } = await import("../server/src/services/timeline-manager.ts");
  const tm = new TimelineManager();
  const label = arg("--label");
  const newId = tm.forkFromSnapshot(worldDir, timelineId, snapshotId, label);
  console.log(`已分叉出新时间线 ${newId}`);
  console.log(`  源：${timelineId}  快照：${snapshotId}`);
  console.log(`  切换过去：POST /api/timelines/${newId}/load`);
}

async function cmdDiff() {
  const worldDir = resolveWorldDir(arg("--world"));
  const a = args[1];
  const b = args[2];
  if (!a || !b) throw new Error("用法：npm run timeline -- diff <timelineA> <timelineB>");

  const { compareTimelineStates, readForkedFrom } = await import(
    "../server/src/services/timeline-comparator.ts"
  );

  const metas = listTimelines(worldDir);
  const metaA = metas.find((t) => t.id === a);
  const metaB = metas.find((t) => t.id === b);
  if (!metaA || !metaB) throw new Error("Timeline not found");

  const cmp = compareTimelineStates(
    dbPath(worldDir, a),
    dbPath(worldDir, b),
    { id: metaA.id, label: metaA.label, lastGameTime: metaA.lastGameTime, tickCount: metaA.tickCount },
    { id: metaB.id, label: metaB.label, lastGameTime: metaB.lastGameTime, tickCount: metaB.tickCount },
    readForkedFrom(timelineDir(worldDir, b)),
  );

  console.log(`A: ${cmp.timelineA.id}${cmp.timelineA.label ? ` 「${cmp.timelineA.label}」` : ""}`);
  console.log(`   day ${cmp.timelineA.lastGameTime?.day} tick ${cmp.timelineA.lastGameTime?.tick}, ${cmp.timelineA.tickCount} 帧, ${cmp.eventCounts.a} 事件`);
  console.log(`B: ${cmp.timelineB.id}${cmp.timelineB.label ? ` 「${cmp.timelineB.label}」` : ""}`);
  console.log(`   day ${cmp.timelineB.lastGameTime?.day} tick ${cmp.timelineB.lastGameTime?.tick}, ${cmp.timelineB.tickCount} 帧, ${cmp.eventCounts.b} 事件`);
  if (cmp.forkedFrom) {
    console.log(`\n分叉自 ${cmp.forkedFrom.timelineId} @ day ${cmp.forkedFrom.day} tick ${cmp.forkedFrom.tick}`);
  }

  if (cmp.characters.length === 0) {
    console.log("\n角色状态：无差异");
  } else {
    console.log("\n角色状态差异：");
    for (const c of cmp.characters) {
      if (c.onlyIn === "a") {
        console.log(`  ${c.characterId}: 只在 A 中存在`);
      } else if (c.onlyIn === "b") {
        console.log(`  ${c.characterId}: 只在 B 中存在`);
      } else {
        console.log(`  ${c.characterId}:`);
        for (const f of c.fields) {
          console.log(`    ${f.field}: A=${JSON.stringify(f.a)}  B=${JSON.stringify(f.b)}`);
        }
      }
    }
  }

  if (cmp.memories.length > 0) {
    console.log("\n记忆差异：");
    for (const m of cmp.memories) {
      console.log(`  ${m.characterId}: 共有 ${m.common}，只 A 有 ${m.onlyInA}，只 B 有 ${m.onlyInB}`);
    }
  }
}

// ─── 入口 ───────────────────────────────────────────────────────────────────

const COMMANDS = {
  list: cmdList,
  snapshots: cmdSnapshots,
  snapshot: cmdSnapshot,
  restore: cmdRestore,
  fork: cmdFork,
  diff: cmdDiff,
};

const command = args[0];
if (!command || !COMMANDS[command]) {
  console.error("用法：npm run timeline -- <list|snapshots|snapshot|restore|fork|diff> ...");
  console.error("  list                                   列出时间线");
  console.error("  snapshots <timelineId>                 列出快照");
  console.error("  snapshot  <timelineId> [--desc ...]    创建快照");
  console.error("  restore  <timelineId> <snapshotId> [--force]  恢复到快照");
  console.error("  fork <timelineId> <snapshotId> [--label ...]  从快照分叉");
  console.error("  diff <timelineA> <timelineB>           对比两条时间线");
  process.exit(1);
}

try {
  await COMMANDS[command]();
} catch (err) {
  console.error(`错误：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
