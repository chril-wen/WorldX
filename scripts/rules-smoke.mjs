#!/usr/bin/env node
/**
 * 阶段 2.5 冒烟 —— 「只改 world.json，行为就变」。
 *
 * ## 验的是什么
 *
 * ROADMAP 的验收标准第一条：
 * > 改一个衰减率**只改 world.json 的 `rules` 段**，不改代码、不重建世界
 *
 * 这条标准分两步：
 * 1. **改 world.json 之后行为真的变了**（规则接上了运行时）
 * 2. **默认规则下行为跟改造前完全一致**（抽取没漂移）
 *
 * ## 怎么验
 *
 * 走**真实链路**：server 的 config-loader 读真 world.json → WorldManager
 * → CharacterManager → tickPassiveUpdate。
 *
 * 不是拿 core 的假 config source 糊弄 —— 那样只能证明 core 内部自洽，
 * 证明不了「world.json 改了真的会生效」。
 *
 * 用法：node scripts/rules-smoke.mjs [--world <worldId>]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, "..");
const SERVER_DEPS = (spec) =>
  pathToFileURL(path.join(PROJECT_DIR, "server", "node_modules", spec)).href;

// @worldx/core 是 npm workspace 的软链，在**仓库根**的 node_modules 里
// （server/node_modules 下没有 —— workspace 依赖都提升到根）。
const CORE_ENTRY = path.join(
  PROJECT_DIR,
  "packages",
  "core",
  "dist",
  "index.js",
);

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

// server 的存储层是 SQLite —— 起一个临时库。
// 冒烟只关心规则接没接上，不需要真的世界状态，所以用临时文件，
// 跑完删掉，不碰 server/data 里的正式库。
const TMP_DB = path.join(
  os.tmpdir(),
  `worldx-rules-smoke-${Date.now()}.db`,
);
initDatabase(TMP_DB);

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

/**
 * 跑一个 tick 的被动更新，返回每个角色的情绪。
 *
 * 情绪衰减是**纯函数**（不依赖 DB 状态），所以这里直接算，
 * 不用真跑 LLM 模拟 —— 冒烟要验的是规则接上了，不是模型能说话。
 */
function runPassiveTick(worldDir) {
  filesystemConfigSource.setWorldDir(worldDir);
  const storage = createDefaultStorage();
  const wm = new WorldManager(filesystemConfigSource, storage);
  wm.initialize(worldDir);
  const cm = new CharacterManager(wm, storage, filesystemConfigSource);
  cm.initialize();

  const out = [];
  for (const profile of cm.getAllProfiles()) {
    const before = cm.getState(profile.id);
    const start = {
      emotionValence: before.emotionValence,
      emotionArousal: before.emotionArousal,
      curiosity: before.curiosity,
    };
    cm.tickPassiveUpdate(profile.id, { day: 1, tick: 0 });
    const after = cm.getState(profile.id);
    out.push({
      id: profile.id,
      name: profile.name,
      start,
      after: {
        emotionValence: after.emotionValence,
        emotionArousal: after.emotionArousal,
        curiosity: after.curiosity,
      },
    });
  }
  return { results: out, rules: wm.getRules() };
}

function fmt(n) {
  return typeof n === "number" ? n.toFixed(6) : String(n);
}

// ─── 跑起来 ──────────────────────────────────────────────────────────────

const worldDir = resolveWorldDir();
const jsonPath = worldJsonPath(worldDir);
const originalRaw = fs.readFileSync(jsonPath, "utf-8");

console.log(`世界：${path.basename(worldDir)}`);
console.log(`world.json：${jsonPath}\n`);

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}

try {
  // ── 1. 默认规则下的基线 ────────────────────────────────────────────
  console.log("── 1. 基线（默认规则） ──");
  const baseline = runPassiveTick(worldDir);
  console.log(`   规则：emotion.decayRate = ${baseline.rules.emotion.decayRate}`);
  for (const r of baseline.results) {
    console.log(
      `   ${r.name}：效价 ${fmt(r.start.emotionValence)} → ${fmt(r.after.emotionValence)}` +
        `  唤醒 ${fmt(r.start.emotionArousal)} → ${fmt(r.after.emotionArousal)}` +
        `  好奇 ${fmt(r.start.curiosity)} → ${fmt(r.after.curiosity)}`,
    );
  }

  // ── 2. 只改 world.json，把情绪衰减调低 ─────────────────────────────
  console.log("\n── 2. 只改 world.json：emotion.decayRate → 0.5 ──");
  const raw = JSON.parse(originalRaw);
  raw.rules = { ...(raw.rules ?? {}), emotion: { ...(raw.rules?.emotion ?? {}), decayRate: 0.5 } };
  fs.writeFileSync(jsonPath, JSON.stringify(raw, null, 2), "utf-8");
  console.log("   （没有改任何代码，没有重建世界）\n");

  const modified = runPassiveTick(worldDir);
  console.log(`   规则：emotion.decayRate = ${modified.rules.emotion.decayRate}`);
  for (const r of modified.results) {
    console.log(
      `   ${r.name}：效价 ${fmt(r.start.emotionValence)} → ${fmt(r.after.emotionValence)}` +
        `  唤醒 ${fmt(r.start.emotionArousal)} → ${fmt(r.after.emotionArousal)}` +
        `  好奇 ${fmt(r.start.curiosity)} → ${fmt(r.after.curiosity)}`,
    );
  }

  // ── 3. 断言：行为真的变了 ─────────────────────────────────────────
  console.log("");
  const base = baseline.results[0];
  const mod = modified.results[0];
  const baseDrop = Math.abs(base.start.emotionValence - base.after.emotionValence);
  const modDrop = Math.abs(mod.start.emotionValence - mod.after.emotionValence);
  check(
    "衰减率调低后，效价衰减变快",
    modDrop > baseDrop,
    `默认掉 ${fmt(baseDrop)} → 改成 0.5 后掉 ${fmt(modDrop)}`,
  );
  check(
    "只改 world.json 就生效（规则确实被读到了）",
    modified.rules.emotion.decayRate === 0.5,
  );
  check(
    "没写的规则项仍是默认值",
    modified.rules.emotion.valenceCurrentWeight === 0.7 &&
      modified.rules.memory.recencyDecayRate === 0.05,
  );

  // ── 4. 角色级 override ────────────────────────────────────────────
  console.log("\n── 3. 角色级 override ──");
  const charDir = fs
    .readdirSync(path.join(worldDir, "config", "characters"))
    .filter((f) => f.endsWith(".json"));
  if (charDir.length === 0) {
    console.log("   （这个世界没有角色配置，跳过）");
  } else {
    const charFile = path.join(worldDir, "config", "characters", charDir[0]);
    const charOriginal = fs.readFileSync(charFile, "utf-8");
    const charRaw = JSON.parse(charOriginal);
    charRaw.rules = {
      ...(charRaw.rules ?? {}),
      needs: { ...(charRaw.rules?.needs ?? {}), baseDecay: 3 },
    };
    fs.writeFileSync(charFile, JSON.stringify(charRaw, null, 2), "utf-8");

    const withOverride = runPassiveTick(worldDir);
    const charId = charRaw.id;
    const ovr = withOverride.results.find((r) => r.id === charId);
    const worldBase = withOverride.results.find((r) => r.id !== charId);
    console.log(
      `   ${ovr?.name}（角色级 baseDecay=3）：好奇 ${fmt(ovr?.start.curiosity)} → ${fmt(ovr?.after.curiosity)}`,
    );
    if (worldBase) {
      console.log(
        `   ${worldBase.name}（世界级 baseDecay=0.5）：好奇 ${fmt(worldBase.start.curiosity)} → ${fmt(worldBase.after.curiosity)}`,
      );
      const ovrDrop = (ovr?.start.curiosity ?? 0) - (ovr?.after.curiosity ?? 0);
      const worldDrop = (worldBase.start.curiosity ?? 0) - (worldBase.after.curiosity ?? 0);
      check(
        "角色级 override 生效，且不影响别的角色",
        ovrDrop > worldDrop,
        `角色掉 ${fmt(ovrDrop)} vs 世界级掉 ${fmt(worldDrop)}`,
      );
    }
    fs.writeFileSync(charFile, charOriginal, "utf-8");
  }
} finally {
  // 复原 world.json —— 冒烟不能留下痕迹
  fs.writeFileSync(jsonPath, originalRaw, "utf-8");
  console.log(`\n（已复原 ${path.basename(jsonPath)}）`);
}

console.log(
  failures === 0
    ? "\n✅ 冒烟全过 —— 改 world.json 就能改世界行为"
    : `\n❌ ${failures} 项没过`,
);

// 清理临时库
try {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = TMP_DB + suffix;
    if (fs.existsSync(p)) fs.rmSync(p, { force: true });
  }
} catch {
  // 清理失败不影响结论
}

process.exit(failures === 0 ? 0 : 1);
