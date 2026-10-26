#!/usr/bin/env node
/**
 * 阶段 2.5 长模拟对拍 —— 同一个世界，只改规则，跑两遍，对比。
 *
 * ## 为什么要有这个
 *
 * 阶段 2.5 的冒烟只验了 `tickPassiveUpdate`（情绪衰减、好奇心衰减）。
 * 那些是**纯函数**，不调模型。
 *
 * 但用户真正关心的是端到端：改一条记忆规则，角色的记忆、对话、
 * 反思会不会真的不一样。这个冒烟没覆盖。
 *
 * ## 关键难点：LLM 不确定
 *
 * 真实 LLM 输出不确定（temperature 没设成 0），所以「跑两遍对比结果」
 * 没法直接做 —— 两次跑的差异可能全来自模型随机性，跟规则无关。
 *
 * ## 解法：注入确定性的假 LLM
 *
 * core 的 `LLMClient` 是个干净的端口，server 有真实现，测试能塞假的。
 * 这里塞一个**确定性**的假模型：同样的输入永远给同样的输出。
 *
 * 于是两次运行唯一的变量就是**规则**。任何差异都必然来自规则。
 *
 * 这验的不是「LLM 会不会好好用规则」，而是「规则有没有真的接进整条链路」——
 * 记忆检索、对话上下文、反思，全部走一遍。
 *
 * ## 还要跑一遍真 LLM
 *
 * 假模型验的是「链路通不通」。真模型验的是「链路通的时候，
 * 真的调用没出错、结果合理」。所以脚本最后跑一段真的。
 *
 * 用法：
 *   node scripts/rules-ab.mjs [--world <worldId>] [--ticks 12] [--real]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, "..");
const SERVER_DEPS = (spec) =>
  pathToFileURL(path.join(PROJECT_DIR, "server", "node_modules", spec)).href;

const CORE = pathToFileURL(
  path.join(PROJECT_DIR, "packages", "core", "dist", "index.js"),
).href;

const args = process.argv.slice(2);
const arg = (flag, fallback = null) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--")
    ? args[i + 1]
    : fallback;
};
const has = (flag) => args.includes(flag);

const GENERATED_WORLDS_DIR = path.join(PROJECT_DIR, "output", "worlds");
const LIBRARY_WORLDS_DIR = path.join(PROJECT_DIR, "library", "worlds");

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
  const wanted = arg("--world");
  if (wanted) {
    const found = dirs.find((d) => path.basename(d) === wanted);
    if (!found) throw new Error(`找不到世界：${wanted}`);
    return found;
  }
  const generated = dirs.filter((d) => d.startsWith(GENERATED_WORLDS_DIR));
  const pool = generated.length > 0 ? generated : dirs;
  pool.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
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
 * 算「跑够多少 tick 才能跨过至少一个日末」。
 *
 * ## 为什么需要这个
 *
 * 记忆巩固（`processMemoryConsolidation`）**只在日末触发** ——
 * 见 `packages/core/src/simulation/simulation-engine.ts` 的 `runEndOfDayDecay`。
 *
 * 而「一天多少 tick」由世界的场景配置决定：
 * `tickDurationMinutes: 15` → 一天 96 tick。
 *
 * 之前这里硬编码 12 tick —— **跨不过日末**，于是：
 * 巩固从不发生 → 长期记忆恒为 0 → A 轮和 B 轮**完全一样** →
 * 「规则没接进链路」。
 *
 * 那是**假阴性**：规则其实接得很牢。跑够 tick 数就能看到差异
 * （实测 100 tick → 「✅ 6 处不同」，长期记忆 22 → 5）。
 *
 * ## 怎么算
 *
 * 读 `config/scene.json` 的 `tickDurationMinutes`，
 * 一天 = 1440 分钟，取 2 倍确保跨过日末（多跑一段看累积效果）。
 *
 * 读不到就用 96 —— 保守但安全（宁可多跑，不要漏掉日末）。
 */
function computeTickCount(worldDir, explicit) {
  if (Number.isFinite(explicit) && explicit > 0) return explicit;

  let minutes = null;
  const scenePath = path.join(worldDir, "config", "scene.json");
  if (fs.existsSync(scenePath)) {
    try {
      const scene = JSON.parse(fs.readFileSync(scenePath, "utf-8"));
      if (Number.isFinite(scene.tickDurationMinutes) && scene.tickDurationMinutes > 0) {
        minutes = scene.tickDurationMinutes;
      }
    } catch {
      // 读不了就用默认值
    }
  }

  const perDay = minutes ? Math.max(1, Math.round((24 * 60) / minutes)) : 96;
  return perDay * 2;
}

// ─── 确定性假 LLM ───────────────────────────────────────────────────────

/**
 * 固定种子：随机数 + 时间戳。
 *
 * 引擎里除了 `Math.random()`，还有 `Date.now()` ——
 * **出生位置的分配种子里含了 `Date.now()`**：
 * `spawnSeedSalt = 'init:' + Date.now().toString(36)`。
 *
 * 所以每次运行角色站在**不同的位置** → 感知到的人不同 →
 * 行为不同 → 对话不同。这不是规则的差异，是时间戳的差异。
 *
 * 把 `Date.now()` 也固定掉，链路才真正确定。
 */
function installDeterministicClock(seed) {
  const originalRandom = Math.random;
  const originalNow = Date.now;
  let s = seed >>> 0;
  let t = 1750000000000; // 固定一个基准时刻
  Math.random = function seededRandom() {
    // xorshift32
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
  Date.now = () => (t += 1000);
  return () => {
    Math.random = originalRandom;
    Date.now = originalNow;
  };
}

/**
 * 从消息内容里抠出可判定的线索，生成一个**确定性**的回应。
 *
 * 不用随机数 —— 同样的输入永远给同样的输出，
 * 这样两次运行的差异只能来自规则。
 */
function makeFakeLLM() {
  const calls = [];
  return {
    calls,
    async call({ messages, schema, options }) {
      const prompt = messages.map((m) => m.content).join("\n");
      calls.push({ taskType: options.taskType, prompt });

      // 按 taskType 造符合各自 schema 的数据。
      // 用 prompt 里的线索做选择 —— 这样「检索到的记忆变了」会体现为
      // 「模型的选择变了」，规则的影响就能一路传到对话和反思。
      const data = buildFakeData(options.taskType, prompt, schema);
      return {
        data,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        model: "fake-deterministic",
        durationMs: 0,
      };
    },
  };
}

/** 从 prompt 里找角色名和关键词，用它们做确定性的选择。 */
function pickFrom(prompt, options) {
  const hash = [...prompt].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  return options[hash % options.length];
}

/**
 * 从 action menu 里抠出**真实可执行**的动作。
 *
 * 菜单的格式是固定的：
 *   `3. [world_action] "名称"(action_id)（时长）`
 *   `4. [interact_object] 物件名(obj_id) → "交互名"(inter_id)（时长）`
 *   `5. [talk_to] 名字(角色, char_id) — 空闲`
 *
 * 假 LLM 必须挑一个**真的在菜单里**的动作 —— 否则引擎会把它当非法决策丢掉，
 * 事件一个都产生不了（我第一版就栽在这）。
 */
function parseActionMenu(prompt) {
  const actions = [];
  for (const line of prompt.split("\n")) {
    const m = line.match(/^\s*\d+\.\s*\[(\w+)\]\s*(.*)$/);
    if (!m) continue;
    const [, type, rest] = m;

    if (type === "talk_to") {
      const idMatch = rest.match(/\(([^,)]+),\s*([a-zA-Z0-9_-]+)\)/);
      if (idMatch) {
        actions.push({ type, targetId: idMatch[2], interactionId: undefined });
      }
      continue;
    }
    if (type === "interact_object") {
      // → "交互名"(inter_id)
      const interMatch = rest.match(/→\s*"[^"]*"\(([a-zA-Z0-9_-]+)\)/);
      if (interMatch) {
        actions.push({
          type,
          targetId: interMatch[1],
          interactionId: interMatch[1],
        });
      }
      continue;
    }
    if (type === "world_action") {
      const idMatch = rest.match(/\(([a-zA-Z0-9_-]+)\)/);
      if (idMatch) {
        actions.push({ type, targetId: idMatch[1], interactionId: undefined });
      }
      continue;
    }
  }
  return actions;
}

function buildFakeData(taskType, prompt, schema) {
  switch (taskType) {
    case "reactive_decision": {
      // 挑一个菜单里**真的存在**的动作 —— 否则引擎直接丢弃，事件为 0
      const actions = parseActionMenu(prompt);
      if (actions.length === 0) {
        return {
          actionType: "idle",
          targetId: "",
          reason: "没有可执行的动作，站着发呆",
          innerMonologue: "无事可做",
        };
      }
      // 确定性地挑一个
      const chosen = actions[hashIndex(prompt, actions.length)];
      return {
        actionType: chosen.type,
        targetId: chosen.targetId,
        interactionId: chosen.interactionId,
        reason: "确定性决策理由，足够长以满足最小长度约束",
        innerMonologue: "确定性内心独白",
      };
    }
    case "dialogue_turn": {
      // 从 prompt 里抠出当前角色名 —— 检索到的记忆变了，
      // 这里看到的内容就变了，对话因此会不同。
      const nameMatch = prompt.match(/「([^」]{1,20})」/);
      return {
        speaker: nameMatch ? nameMatch[1] : "角色",
        content: `确定性发言${nameMatch ? `（${nameMatch[1]}）` : ""}`,
        innerMonologue: "确定性内心",
        shouldContinue: true,
        suggestedNextSpeaker: undefined,
        endReason: undefined,
        tags: [],
      };
    }
    case "dialogue_finalize": {
      return {
        memoriesGenerated: {},
        tags: ["fake"],
        endReason: "确定性收尾",
        hearsayGenerated: {},
      };
    }
    case "memory_eval": {
      // 每条待评估记忆给一个**由内容决定**的确定性评分。
      //
      // 注意：**不能用记忆 id** 来定评分 —— id 是 nanoid 生成的，每次运行都不同，
      // 用了它评分就随机了，两次运行的差异就分不清是规则还是随机。
      // 内容是稳定的，用内容。
      const pairs = [
        ...prompt.matchAll(/\[([a-zA-Z0-9_-]+)\]\s*(.*)/g),
      ];
      const evaluations = pairs.map(([, id, content]) => ({
        memoryId: id,
        importance: 4 + (hashString(content) % 4),
        emotionalValence: 0,
        emotionalIntensity: 1 + (hashString(content) % 3),
        tags: ["fake"],
      }));
      return { evaluations };
    }
    case "reflection": {
      return {
        insights: [
          {
            content: "确定性洞见",
            relatedMemoryIds: [],
            importance: 6,
            tags: ["reflection"],
          },
        ],
        emotionShift: { valence: 0, arousal: 0 },
      };
    }
    case "micro_reflection": {
      return {
        insight: "确定性微反思",
        emotionShift: { valence: 0, arousal: 0 },
        tags: ["fake"],
      };
    }
    case "diary": {
      return {
        content: "确定性日记内容，足够长以满足最小长度约束",
        mood: "平静",
        tags: ["fake"],
      };
    }
    default:
      // 兜底：给 schema 里的每个字段一个合理默认值
      return buildBySchema(schema);
  }
}

/** 由 prompt 决定的下标 —— 确定性，不用随机数。 */
function hashIndex(prompt, len) {
  if (len <= 1) return 0;
  return hashString(prompt) % len;
}

/** 字符串哈希 —— 同样的字符串永远给同样的数。 */
function hashString(s) {
  let h = 7;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

/** 按 zod schema 造一个最小合法对象（兜底用）。 */
function buildBySchema(schema) {
  try {
    const shape = schema?.shape;
    if (!shape) return {};
    const out = {};
    for (const [key, def] of Object.entries(shape)) {
      const t = def?._def?.typeName;
      if (t === "ZodArray") out[key] = [];
      else if (t === "ZodNumber") out[key] = 0;
      else if (t === "ZodBoolean") out[key] = false;
      else out[key] = "";
    }
    return out;
  } catch {
    return {};
  }
}

// ─── 跑一遍 ──────────────────────────────────────────────────────────────

const worldDir = resolveWorldDir();
const jsonPath = worldJsonPath(worldDir);
const TICK_COUNT = computeTickCount(
  worldDir,
  has("--ticks") ? Number(arg("--ticks")) : null,
);

console.log(`世界：${path.basename(worldDir)}`);
console.log(`world.json：${jsonPath}`);
console.log(`每轮 tick 数：${TICK_COUNT}\n`);

const { WorldManager, CharacterManager } = await import(CORE);
const { SimulationEngine } = await import(
  pathToFileURL(
    path.join(PROJECT_DIR, "packages", "core", "dist", "simulation", "simulation-engine.js"),
  ).href
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

/**
 * 跑一轮模拟，返回可对比的摘要。
 *
 * @param worldRules 世界级规则（写进 world.json）
 */
async function runOnce(worldRules, label) {
  const originalRaw = fs.readFileSync(jsonPath, "utf-8");

  // 1. 把规则写进 world.json（世界级）
  const raw = JSON.parse(originalRaw);
  if (worldRules) raw.rules = worldRules;
  else delete raw.rules;
  fs.writeFileSync(jsonPath, JSON.stringify(raw, null, 2), "utf-8");

  const dbPath = path.join(
    os.tmpdir(),
    `worldx-ab-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`,
  );
  initDatabase(dbPath);

  // 固定种子的随机数 —— 每轮用**同一个**种子，
  // 这样 A 和 B 之间的差异只可能来自规则。
  // 声明在 try 外面，finally 里才能复原。
  const restoreRandom = installDeterministicClock(20261025);

  try {
    filesystemConfigSource.setWorldDir(worldDir);
    const storage = createDefaultStorage();
    const wm = new WorldManager(filesystemConfigSource, storage);
    wm.initialize(worldDir);
    const cm = new CharacterManager(wm, storage, filesystemConfigSource);
    cm.initialize();

    const fake = makeFakeLLM();
    const engine = new SimulationEngine(
      wm,
      cm,
      fake,
      // promptBuilder 需要真模板 —— 从 server 借
      await buildPromptBuilder(),
      storage,
    );

    const events = [];
    for (let i = 0; i < TICK_COUNT; i++) {
      const tickEvents = await engine.simulateTick();
      events.push(...tickEvents);
    }

    // 记忆评估是**后台**跑的（micro_reflection 之后排队），
    // 关库之前必须等它跑完 —— 否则后台任务碰到已关闭的 DB 会报错。
    await engine.flushPendingMemoryEvaluation?.();
    // 引擎没把这个方法暴露成 public 的话，退而求其次等一小会儿
    if (typeof engine.flushPendingMemoryEvaluation !== "function") {
      await new Promise((r) => setTimeout(r, 500));
    }

    // 诊断：模拟结束后的可观测状态
    const diag = {
      llmCallsByType: countBy(fake.calls.map((c) => c.taskType)),
      characterStates: cm.getAllProfiles().map((p) => {
        const s = cm.getState(p.id);
        return {
          name: p.name,
          action: s.currentAction,
          actionEndTick: s.actionEndTick,
          emotionValence: round(s.emotionValence),
          emotionArousal: round(s.emotionArousal),
          curiosity: round(s.curiosity),
        };
      }),
    };
    if (process.env.AB_DEBUG) {
      console.log("   诊断：", JSON.stringify(diag, null, 2));
    }

    // 摘要：模拟结束后能观测到的东西
    const summary = {
      label,
      tickCount: TICK_COUNT,
      eventCount: events.length,
      eventTypes: countBy(events.map((e) => e.type)),
      // 每个角色的记忆状态
      memories: cm.getAllProfiles().map((p) => {
        const mems = cm.memoryManager.getRecentMemories(p.id, 100);
        return {
          id: p.id,
          name: p.name,
          count: mems.length,
          longTerm: mems.filter((m) => m.isLongTerm).length,
          avgImportance: avg(mems.map((m) => m.importance)),
          avgDecay: avg(mems.map((m) => m.decayFactor)),
          avgValence: avg(mems.map((m) => m.emotionalValence)),
          // 记忆内容排序 —— 检索规则变了这里就会变
          topContents: mems
            .slice(0, 3)
            .map((m) => m.content)
            .join(" | "),
        };
      }),
      // 角色状态
      states: cm.getAllProfiles().map((p) => {
        const s = cm.getState(p.id);
        return {
          id: p.id,
          name: p.name,
          emotionValence: round(s.emotionValence),
          emotionArousal: round(s.emotionArousal),
          curiosity: round(s.curiosity),
        };
      }),
      llmCalls: fake.calls.length,
      diag,
    };

    return summary;
  } finally {
    // 复原 world.json
    fs.writeFileSync(jsonPath, originalRaw, "utf-8");
    // 复原 Math.random
    restoreRandom?.();
    try {
      closeDb();
      for (const suffix of ["", "-wal", "-shm"]) {
        const p = dbPath + suffix;
        if (fs.existsSync(p)) fs.rmSync(p, { force: true });
      }
    } catch {
      // 清理失败不影响对比
    }
  }
}

async function buildPromptBuilder() {
  const { PromptBuilder } = await import(
    pathToFileURL(
      path.join(PROJECT_DIR, "packages", "core", "dist", "llm", "prompt-builder.js"),
    ).href
  );
  const { filesystemTemplateSource } = await import(
    SERVER_DEPS(path.join("../dist/store/template-source.js"))
  );
  const pb = new PromptBuilder(filesystemTemplateSource);
  pb.initialize();
  return pb;
}

function countBy(list) {
  const out = {};
  for (const x of list) out[x] = (out[x] ?? 0) + 1;
  return out;
}
function avg(list) {
  if (!list.length) return 0;
  return list.reduce((a, b) => a + b, 0) / list.length;
}
function round(n) {
  return typeof n === "number" ? Math.round(n * 1000) / 1000 : n;
}

// ─── 对比 ────────────────────────────────────────────────────────────────

console.log("── A：默认规则 ──");
const A = await runOnce(null, "A");
console.log(`   事件 ${A.eventCount} 个，LLM 调用 ${A.llmCalls} 次`);
for (const m of A.memories) {
  console.log(
    `   ${m.name}：记忆 ${m.count} 条（长期 ${m.longTerm}）` +
      ` 重要度均 ${round(m.avgImportance)} 衰减均 ${round(m.avgDecay)}`,
  );
}

// A/A 对照 —— **同样规则跑两遍**，用来验证「差异只可能来自规则」。
//
// 这一步很重要：把规则变量去掉，如果两次结果还是不一样，
// 说明链路里还有随机源（nanoid、时间戳、未固定的随机），
// 那么后面 A/B 的差异就不能全部归给规则。
if (has("--aa")) {
  console.log("\n── A/A 对照：同样规则跑两遍（差异应当为 0）──");
  const A2 = await runOnce(null, "A2");
  let aaDiffs = 0;
  const aaCompare = (label, a, b) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      aaDiffs++;
      console.log(`   ⚠️ 不同  ${label}`);
      console.log(`      A : ${JSON.stringify(a)}`);
      console.log(`      A2: ${JSON.stringify(b)}`);
    }
  };
  aaCompare("事件总数", A.eventCount, A2.eventCount);
  aaCompare("事件类型分布", A.eventTypes, A2.eventTypes);
  for (let i = 0; i < A.memories.length; i++) {
    aaCompare(`${A.memories[i].name} 的记忆条数`, A.memories[i].count, A2.memories[i].count);
    aaCompare(`${A.memories[i].name} 的长期记忆数`, A.memories[i].longTerm, A2.memories[i].longTerm);
    aaCompare(`${A.memories[i].name} 的记忆排序`, A.memories[i].topContents, A2.memories[i].topContents);
  }
  console.log(
    aaDiffs === 0
      ? "   ✅ 两遍完全一致 —— 链路是确定性的，差异只能来自规则"
      : `   ⚠️ 两遍有 ${aaDiffs} 处不同 —— 链路里还有随机源，A/B 的差异不能全归给规则`,
  );
}

console.log("\n── B：记忆规则全改（巩固门限↑ + 检索权重↑）──");
const B = await runOnce(
  {
    memory: {
      // 巩固门限拉高 → 记忆更少转成长期记忆
      consolidateImportance: 9,
      consolidateAccessCount: 8,
      // 检索权重 → 检索到的记忆排序变
      relevanceWeight: 8,
      recencyWeight: 1,
      recencyDecayRate: 0.5,
    },
  },
  "B",
);
console.log(`   事件 ${B.eventCount} 个，LLM 调用 ${B.llmCalls} 次`);
for (const m of B.memories) {
  console.log(
    `   ${m.name}：记忆 ${m.count} 条（长期 ${m.longTerm}）` +
      ` 重要度均 ${round(m.avgImportance)} 衰减均 ${round(m.avgDecay)}`,
  );
}

console.log("\n── 对比 ──");
let diffs = 0;
function compare(label, a, b) {
  const same = JSON.stringify(a) === JSON.stringify(b);
  if (!same) diffs++;
  console.log(`   ${same ? "⚪ 相同" : "✅ 不同"}  ${label}`);
  if (!same) {
    console.log(`      A: ${JSON.stringify(a)}`);
    console.log(`      B: ${JSON.stringify(b)}`);
  }
}

compare("事件总数", A.eventCount, B.eventCount);
compare("事件类型分布", A.eventTypes, B.eventTypes);
for (let i = 0; i < A.memories.length; i++) {
  const a = A.memories[i];
  const b = B.memories[i];
  compare(`${a.name} 的记忆条数`, a.count, b.count);
  compare(`${a.name} 的长期记忆数`, a.longTerm, b.longTerm);
  compare(`${a.name} 的记忆平均衰减因子`, a.avgDecay, b.avgDecay);
  compare(`${a.name} 的记忆排序`, a.topContents, b.topContents);
}
for (let i = 0; i < A.states.length; i++) {
  compare(`${A.states[i].name} 的情绪效价`, A.states[i].emotionValence, B.states[i].emotionValence);
  compare(`${A.states[i].name} 的好奇`, A.states[i].curiosity, B.states[i].curiosity);
}

console.log(
  diffs > 0
    ? `\n✅ ${diffs} 处不同 —— 规则真的接进了整条链路（决策 → 对话 → 记忆 → 反思）`
    : `\n❌ 两轮完全一样 —— 规则没接进链路，这是个 bug`,
);

// ─── 方向性断言：差异不只是「有」，还得「对」 ──────────────────────────
//
// 「有差异」只能证明有东西变了，不能证明变的是规则。
// 所以再断言**方向**：B 把巩固门限拉高了，长期记忆就该**变少**。
// 方向反了，说明规则接到了别的地方 —— 那也是 bug。
console.log("\n── 方向性断言 ──");
let wrongDirection = 0;
for (let i = 0; i < A.memories.length; i++) {
  const a = A.memories[i];
  const b = B.memories[i];
  // B 的 consolidateImportance=9 / consolidateAccessCount=8 都比默认高
  // → 长期记忆应该变少或持平，不可能变多
  const ok = b.longTerm <= a.longTerm;
  if (!ok) wrongDirection++;
  console.log(
    `   ${ok ? "✅" : "❌"} ${a.name}：长期记忆 ${a.longTerm} → ${b.longTerm}` +
      `（巩固门限拉高，应该变少）`,
  );
}
if (wrongDirection > 0) {
  console.log(
    `\n❌ ${wrongDirection} 个角色的长期记忆反而变多了 —— 规则可能接到了别的地方`,
  );
  process.exit(1);
}

// ─── 真 LLM 跑一遍 ──────────────────────────────────────────────────────
//
// 假模型验的是「链路通不通」。真模型验的是「链路通的时候，
// 真的调用没出错、结果合理」。
//
// 真 LLM 不确定，所以**不比结果**，只看：
//   1. 每次调用都成功（没有 schema 校验失败、没有解析错误）
//   2. 事件真的产生了
//   3. 记忆真的写进去了
if (has("--real")) {
  console.log("\n── 真 LLM 跑一遍（不比对结果，只看链路通不通）──");
  const realTicks = Number(arg("--real-ticks", "6"));
  try {
    const r = await runWithRealLLM(realTicks);
    console.log(
      `   事件 ${r.eventCount} 个，LLM 调用 ${r.llmCalls} 次` +
        `（成功 ${r.okCalls}，失败 ${r.failCalls}）`,
    );
    for (const m of r.memories) {
      console.log(
        `   ${m.name}：记忆 ${m.count} 条（长期 ${m.longTerm}）` +
          ` 重要度均 ${round(m.avgImportance)}`,
      );
    }
    console.log(
      r.failCalls === 0 && r.eventCount > 0
        ? "\n✅ 真 LLM 链路通 —— 调用全成功，事件和记忆都产生了"
        : `\n⚠️ 有问题：${r.failCalls} 次调用失败，${r.eventCount} 个事件`,
    );
  } catch (err) {
    console.log(`\n⚠️ 真 LLM 跑失败：${err?.message ?? err}`);
    console.log("   （不影响上面的对拍结论 —— 那是用假模型验的）");
  }
}

process.exit(diffs > 0 ? 0 : 1);

/**
 * 用**真 LLM** 跑一小段。
 *
 * 不比对结果（真 LLM 不确定），只看链路通不通。
 */
async function runWithRealLLM(tickCount) {
  // 真 LLM 需要 .env 里的密钥 —— 密钥永远只在 .env，不进版本库
  const dotenv = await import(
    SERVER_DEPS(path.join("../node_modules/dotenv/lib/main.js"))
  ).catch(() => null);
  if (dotenv) {
    dotenv.config({ path: path.join(PROJECT_DIR, ".env") });
  } else {
    // 没装 dotenv 就手工读 —— 只取需要的键，不打印任何密钥
    const envRaw = fs.readFileSync(path.join(PROJECT_DIR, ".env"), "utf-8");
    for (const line of envRaw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }

  const { LLMClient } = await import(
    pathToFileURL(
      path.join(PROJECT_DIR, "packages", "core", "dist", "llm", "llm-client.js"),
    ).href
  );
  const { buildLLMConfigFromFiles } = await import(
    SERVER_DEPS(path.join("../dist/llm/model-config.js"))
  );

  const dbPath = path.join(
    os.tmpdir(),
    `worldx-ab-real-${Date.now()}.db`,
  );
  initDatabase(dbPath);

  try {
    filesystemConfigSource.setWorldDir(worldDir);
    const storage = createDefaultStorage();
    const wm = new WorldManager(filesystemConfigSource, storage);
    wm.initialize(worldDir);
    const cm = new CharacterManager(wm, storage, filesystemConfigSource);
    cm.initialize();

    let okCalls = 0;
    let failCalls = 0;
    const realLLM = new LLMClient(buildLLMConfigFromFiles());
    const countingLLM = {
      async call(params) {
        try {
          const r = await realLLM.call(params);
          okCalls++;
          return r;
        } catch (err) {
          failCalls++;
          throw err;
        }
      },
    };

    const engine = new SimulationEngine(
      wm,
      cm,
      countingLLM,
      await buildPromptBuilder(),
      storage,
    );

    const events = [];
    for (let i = 0; i < tickCount; i++) {
      events.push(...(await engine.simulateTick()));
    }
    await engine.flushPendingMemoryEvaluation?.();

    return {
      eventCount: events.length,
      llmCalls: okCalls + failCalls,
      okCalls,
      failCalls,
      memories: cm.getAllProfiles().map((p) => {
        const mems = cm.memoryManager.getRecentMemories(p.id, 100);
        return {
          name: p.name,
          count: mems.length,
          longTerm: mems.filter((m) => m.isLongTerm).length,
          avgImportance: avg(mems.map((m) => m.importance)),
        };
      }),
    };
  } finally {
    try {
      closeDb();
      for (const suffix of ["", "-wal", "-shm"]) {
        const p = dbPath + suffix;
        if (fs.existsSync(p)) fs.rmSync(p, { force: true });
      }
    } catch {
      // 清理失败不影响结论
    }
  }
}
