#!/usr/bin/env node
/**
 * 真 LLM 对比 —— 「改了规则，角色的对话和记忆内容真的变了吗」
 *
 * ## 这个脚本和 rules-ab.mjs 的分工
 *
 * `rules-ab.mjs` 用**假 LLM** 验的是「规则有没有接进整条链路」——
 * 那是个二值问题：接上了 / 没接上。
 *
 * 这个脚本用**真 LLM** 验的是另一件事：
 * **链��接上了之后，内容读起来合不合理。**
 *
 * 自动断言验不了「合不合理」——那得人看。所以这个脚本不判断对错，
 * 它只负责**把内容打印出来**，让人看。
 *
 * ## 为什么真 LLM 没法对拍
 *
 * 真 LLM 不确定（temperature 没设成 0），跑两遍结果就不一样。
 * 所以这里**不做 A/B 断言**，只做 A/B **展示**：
 * 两边都跑，把各自的对话和记忆都打出来。
 *
 * 人工比对的依据是**语义**：如果改的是「记忆更短命」，
 * 那 B 组的记忆就该更少、更短命。如果读下来 B 组跟 A 组差不多，
 * 说明规则虽然接上了，但**影响被别的东西盖住了** ——
 * 这是一个自动化断言发现不了的坏情况。
 *
 * ## 用法
 *
 *   node scripts/rules-real-compare.mjs                    # 两组各跑 8 tick
 *   node scripts/rules-real-compare.mjs --ticks 12         # 更长
 *   node scripts/rules-real-compare.mjs --rules B          # 只跑 B 组
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(HERE, "..");
const SERVER_DIR = path.join(PROJECT_DIR, "server");

// ─── 参数 ────────────────────────────────────────────────────────────────
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function has(name) {
  return process.argv.includes(`--${name}`);
}

const TICK_COUNT = Number(arg("ticks", "8"));
const ONLY = arg("rules", null); // "A" | "B" | null
const WORLD_NAME = arg("world", null); // 世界目录名，或完整路径

/**
 * server 的依赖从 `server/node_modules` 解析。
 *
 * 注意 `../dist/...` 这种相对写法是故意的 ——
 * 它从 `server/node_modules/` 往上退一级，正好落到 `server/dist/`。
 * （server 自己的依赖在 `server/node_modules`，不在仓库根。）
 */
function SERVER_DEPS(spec) {
  return pathToFileURL(
    path.join(PROJECT_DIR, "server", "node_modules", spec),
  ).href;
}

// ─── 世界 ────────────────────────────────────────────────────────────────
const outputRoot = path.join(PROJECT_DIR, "output", "worlds");
const worldDirs = fs.existsSync(outputRoot)
  ? fs
      .readdirSync(outputRoot)
      .map((d) => path.join(outputRoot, d))
      .filter((d) => fs.existsSync(path.join(d, "config", "world.json")))
  : [];
if (worldDirs.length === 0) {
  console.error("找不到任何世界 —— 先创建或生成一个。");
  process.exit(1);
}

/**
 * 选世界。
 *
 * 默认挑**最新的**那个 —— 跟 `rules-ab.mjs` 保持一致，
 * 这样两个脚本的结论可以对照着看。
 */
const worldDir = WORLD_NAME
  ? path.isAbsolute(WORLD_NAME)
    ? WORLD_NAME
    : path.join(outputRoot, WORLD_NAME)
  : worldDirs.sort((a, b) => b.localeCompare(a))[0];
const worldJsonPath = path.join(worldDir, "config", "world.json");
const baseWorld = JSON.parse(fs.readFileSync(worldJsonPath, "utf-8"));

console.log(`世界：${baseWorld.name ?? path.basename(worldDir)}`);
console.log(`源目录：${worldDir}`);
console.log(`每组 tick 数：${TICK_COUNT}`);
console.log("（在临时副本上跑 —— 原世界不会被改动）");
console.log();

// ─── 依赖 ────────────────────────────────────────────────────────────────
const { filesystemConfigSource } = await import(
  SERVER_DEPS("../dist/store/config-source.js")
);
const { createDefaultStorage } = await import(
  SERVER_DEPS("../dist/store/storage-adapter.js")
);
const { initDatabase, closeDb } = await import(SERVER_DEPS("../dist/store/db.js"));
const { WorldManager } = await import(
  pathToFileURL(
    path.join(PROJECT_DIR, "packages", "core", "dist", "engine", "world-manager.js"),
  ).href
);
const { CharacterManager } = await import(
  pathToFileURL(
    path.join(
      PROJECT_DIR,
      "packages",
      "core",
      "dist",
      "engine",
      "character-manager.js",
    ),
  ).href
);
const { SimulationEngine } = await import(
  pathToFileURL(
    path.join(
      PROJECT_DIR,
      "packages",
      "core",
      "dist",
      "simulation",
      "simulation-engine.js",
    ),
  ).href
);
const { PromptBuilder } = await import(
  pathToFileURL(
    path.join(PROJECT_DIR, "packages", "core", "dist", "llm", "prompt-builder.js"),
  ).href
);
const { LLMClient } = await import(
  pathToFileURL(
    path.join(PROJECT_DIR, "packages", "core", "dist", "llm", "llm-client.js"),
  ).href
);
const { filesystemTemplateSource } = await import(
  SERVER_DEPS("../dist/store/template-source.js")
);
const { buildLLMConfigFromFiles } = await import(
  SERVER_DEPS("../dist/llm/model-config.js")
);
const MEMORY_MANAGER_MOD = await import(
  pathToFileURL(
    path.join(
      PROJECT_DIR,
      "packages",
      "core",
      "dist",
      "engine",
      "memory-manager.js",
    ),
  ).href
);
const RULES_MOD = await import(
  pathToFileURL(
    path.join(PROJECT_DIR, "packages", "core", "dist", "engine", "rules.js"),
  ).href
);

// ─── 真 LLM 需要 .env 里的密钥 ───────────────────────────────────────────
// 密钥永远只在 .env，不进版本库。
{
  const envPath = path.join(PROJECT_DIR, ".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf-8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
}

/**
 * 把世界**整个复制**到临时目录，在副本上跑。
 *
 * 为什么不就地改 world.json：
 *
 * 1. **就地改有竞态** —— 我第一次跑的时候同时开了两个进程，
 *    一个在写 B 组的规则，另一个在复原，
 *    结果复原被覆盖掉，**真实世界的 world.json 留下了 B 组的规则**。
 *    （那次是靠另一个世界对照才发现的 —— `output/worlds/` 不在版本库里，
 *    git 救不回来。）
 *
 * 2. **就地改有副作用** —— 万一脚本中途崩了，世界的规则就脏了。
 *    规则住在世界里，世界脏了就是真问题。
 *
 * 复制一份的成本很低（一个世界几个文件），换来的是「不可能弄脏原世界」。
 */
function copyWorld(srcDir) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "worldx-realcmp-world-"));
  fs.cpSync(srcDir, tmp, { recursive: true });
  return tmp;
}

/**
 * 两组规则。
 *
 * A 和 A2 用**同样的规则**跑两遍 —— 这是**决定性的对照**。
 *
 * 真 LLM 不确定，所以 A 和 A2 的内容必然不一样（场景都可能不同）。
 * 这一点必须先摆在明面上，否则会把「LLM 随机性造成的差异」
 * 误读成「规则造成的差异」。
 *
 * 有了 A2 作为基线，才谈得上：B 的差异是不是**比随机性更大**。
 */
const RULE_SETS = {
  A: null, // 默认规则（第 1 次）
  A2: null, // 默认规则（第 2 次）—— 对照组
  B: {
    memory: {
      consolidateImportance: 9,
      consolidateAccessCount: 8,
      relevanceWeight: 8,
      recencyWeight: 1,
      recencyDecayRate: 0.5,
    },
  },
};

// ─── 跑一组 ──────────────────────────────────────────────────────────────
async function runGroup(label, rules) {
  // 在**副本**上跑 —— 原世界一个字节都不动
  const workDir = copyWorld(worldDir);
  const workJson = path.join(workDir, "config", "world.json");

  // 写规则进副本的 world.json
  const w = JSON.parse(fs.readFileSync(workJson, "utf-8"));
  if (rules) {
    w.rules = { ...(w.rules ?? {}), ...rules };
  } else {
    delete w.rules;
  }
  fs.writeFileSync(workJson, JSON.stringify(w, null, 2), "utf-8");

  const dbPath = path.join(
    os.tmpdir(),
    `worldx-realcmp-${label}-${Date.now()}.db`,
  );
  initDatabase(dbPath);

  try {
    filesystemConfigSource.setWorldDir(workDir);
    const storage = createDefaultStorage();
    const wm = new WorldManager(filesystemConfigSource, storage);
    wm.initialize(workDir);
    const cm = new CharacterManager(wm, storage, filesystemConfigSource);
    cm.initialize();

    const realLLM = new LLMClient(buildLLMConfigFromFiles());
    let okCalls = 0;
    let failCalls = 0;
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

    const promptBuilder = new PromptBuilder(filesystemTemplateSource);
    promptBuilder.initialize();    const engine = new SimulationEngine(
      wm,
      cm,
      countingLLM,
      promptBuilder,
      storage,
    );

    const events = [];
    for (let i = 0; i < TICK_COUNT; i++) {
      events.push(...(await engine.simulateTick()));
    }
    // 记忆评估在后台跑 —— 关库前要等它跑完
    await engine.flushPendingMemoryEvaluation?.();

    return {
      label,
      events,
      okCalls,
      failCalls,
      /**
       * **严格对照** —— 同一份记忆库，只换规则，重算检索。
       *
       * 上面那个 A/B 检索对比混了两个变量：规则变了，
       * 而且真 LLM 生成的**记忆内容本身**也变了。
       *
       * 这个对照把第二个变量消掉：拿 A 组跑出来的记忆库，
       * 分别用 A 的规则和 B 的规则各检索一次。
       * 唯一的变量就是规则 —— 差异是干净的。
       *
       * 检索是纯计算（不打分模型），所以这个对照**不受 LLM 随机性影响**。
       */
      strictControl: (() => {
        const now = wm.getCurrentTime();
        // 两个 MemoryManager，**同一份记忆库**，只换规则。
        // 检索是纯计算（不打分模型），所以这个对照不受 LLM 随机性影响。
        const { MemoryManager } = MEMORY_MANAGER_MOD;
        const { mergeRules } = RULES_MOD;
        const mk = (ruleSet) =>
          // **不传 rulesResolver** —— 传了的话 resolver 优先，
          // 我构造时传进去的规则就被覆盖了（`getRulesFor` 里
          // `this.rulesResolver?.(characterId) ?? this.rules`）。
          new MemoryManager(storage.memories, undefined, mergeRules(ruleSet).memory);
        const mmA = mk(null);
        const mmB = mk(RULE_SETS.B);
        const out = [];
        for (const p of cm.getAllProfiles()) {
          for (const o of cm.getAllProfiles()) {
            if (o.id === p.id) continue;
            const params = {
              characterId: p.id,
              currentTime: now,
              contextKeywords: [o.name, o.id],
              relatedCharacterIds: [o.id],
              topK: 5,
            };
            out.push({
              who: p.name,
              about: o.name,
              underA: mmA.retrieveMemories(params).map((m) => m.content),
              underB: mmB.retrieveMemories(params).map((m) => m.content),
            });
          }
        }
        return out;
      })(),
      /**
       * 检索快照 —— **规则最直接的可观察效果**。
       *
       * 对话时每个角色会检索「关于对方」的记忆（`contextKeywords` =
       * 对方的名字），这些记忆原样进 prompt。
       * `relevanceWeight` / `recencyWeight` / `recencyDecayRate`
       * 直接决定**哪几条被选中、什么顺序**。
       *
       * 所以这是「规则生效了」最干净的一处证据 ——
       * 不受 LLM 随机性干扰（同一组内两次调用看到的 prompt 一样）。
       */
      retrieval: cm.getAllProfiles().map((p) => {
        const others = cm.getAllProfiles().filter((o) => o.id !== p.id);
        return {
          name: p.name,
          aboutOthers: others.map((o) => {
            const mems = cm.memoryManager.retrieveMemories({
              characterId: p.id,
              currentTime: wm.getCurrentTime(),
              contextKeywords: [o.name, o.id],
              relatedCharacterIds: [o.id],
              topK: 5,
            });
            return {
              about: o.name,
              contents: mems.map((m) => m.content),
            };
          }),
        };
      }),
      characters: cm.getAllProfiles().map((p) => {
        const mems = cm.memoryManager.getRecentMemories(p.id, 200);
        return {
          name: p.name,
          role: p.role,
          memories: mems.map((m) => ({
            content: m.content,
            importance: m.importance,
            isLongTerm: m.isLongTerm,
            decayFactor: m.decayFactor,
            accessCount: m.accessCount,
            gameDay: m.gameDay,
          })),
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
    // 删掉副本
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      // 清理失败不影响结论
    }
  }
}

// ─── 展示 ────────────────────────────────────────────────────────────────
function printGroup(g) {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  ${g.label} 组`);
  console.log(`${"═".repeat(70)}`);

  const fail = g.failCalls > 0 ? `，失败 ${g.failCalls}` : "";
  console.log(
    `  事件 ${g.events.length} 个，LLM 调用 ${g.okCalls + g.failCalls} 次（成功 ${g.okCalls}${fail}）`,
  );

  // 对话
  const dialogues = g.events.filter((e) => e.type === "dialogue");
  console.log(`\n  ── 对话（${dialogues.length} 个事件）──`);
  const nameOf = (id) => g.characters.find((c) => c.name === id)?.name ?? id;
  let shown = 0;
  for (const e of dialogues) {
    const turns = e.data?.turns ?? [];
    if (turns.length === 0) continue;
    console.log(
      `\n  [第${e.gameDay}天 ${e.gameTick}tick @ ${e.location}]`,
    );
    for (const t of turns) {
      console.log(`    ${t.speaker}：${t.content}`);
      if (t.innerMonologue) {
        console.log(`      （内心：${t.innerMonologue}）`);
      }
    }
    shown++;
    if (shown >= 6) {
      console.log(`    …（还有 ${dialogues.length - shown} 个对话事件）`);
      break;
    }
  }
  if (shown === 0) console.log("    （这次没有对话）");

  // 检索快照
  console.log(`\n  ── 检索快照（谁关于谁的记忆进了 prompt）──`);
  for (const r of g.retrieval) {
    for (const ao of r.aboutOthers) {
      if (ao.contents.length === 0) continue;
      console.log(`\n  ${r.name} 关于 ${ao.about}：`);
      for (const c of ao.contents) {
        console.log(`    · ${c}`);
      }
    }
  }

  // 记忆
  console.log(`\n  ── 记忆 ──`);
  for (const c of g.characters) {
    const longTerm = c.memories.filter((m) => m.isLongTerm).length;
    console.log(
      `\n  ${c.name}（${c.role}）：${c.memories.length} 条，其中长期 ${longTerm} 条`,
    );
    for (const m of c.memories.slice(0, 8)) {
      const flag = m.isLongTerm ? "[长期]" : "      ";
      console.log(
        `    ${flag} 重要度${m.importance} 衰减${m.decayFactor.toFixed(2)} ×${m.accessCount}  ${m.content}`,
      );
    }
    if (c.memories.length > 8) {
      console.log(`    …（还有 ${c.memories.length - 8} 条）`);
    }
  }
}

// ─── 跑 ──────────────────────────────────────────────────────────────────
const results = {};
try {
  for (const [label, rules] of Object.entries(RULE_SETS)) {
    if (ONLY && ONLY !== label) continue;
    console.log(`跑 ${label} 组…`);
    results[label] = await runGroup(label, rules);
    printGroup(results[label]);
  }
} finally {
  // 原世界从头到尾没被碰过 —— 每一组都在临时副本上跑。
  // 这里不需要「复原」。
}

// ─── 对比 ────────────────────────────────────────────────────────────────

/**
 * 两组之间的「差异程度」。
 *
 * 真 LLM 的差异不能只看「一样/不一样」——
 * 场景整个换掉的时候，比的是完全不同的话。
 *
 * 所以量三样：
 *   - 记忆条数差
 *   - 记忆**内容**的交集比例（Jaccard）
 *   - 对话轮次的字面重合度
 *
 * Jaccard 最有用：它不受「场景不同」影响 ——
 * 两组如果聊的是同一件事，内容就会大量重合。
 */
function diffDegree(a, b) {
  const memSets = a.characters.map((c) => new Set(c.memories.map((m) => m.content)));
  const memSetsB = b.characters.map((c) => new Set(c.memories.map((m) => m.content)));
  let inter = 0;
  let union = 0;
  for (let i = 0; i < memSets.length; i++) {
    for (const x of memSets[i]) union++;
    for (const x of memSetsB[i]) {
      union++;
      if (memSets[i].has(x)) inter++;
    }
  }
  const jaccard = union > 0 ? inter / union : 1;

  const turnsOf = (g) =>
    g.events
      .filter((e) => e.type === "dialogue")
      .flatMap((e) => (e.data?.turns ?? []).map((t) => t.content));
  const ta = turnsOf(a);
  const tb = turnsOf(b);
  const overlap = ta.filter((t) => tb.some((u) => u === t)).length;
  const turnOverlap = ta.length + tb.length > 0 ? (2 * overlap) / (ta.length + tb.length) : 1;

  return {
    memCountA: a.characters.reduce((s, c) => s + c.memories.length, 0),
    memCountB: b.characters.reduce((s, c) => s + c.memories.length, 0),
    jaccard,
    turnOverlap,
    turnCountA: ta.length,
    turnCountB: tb.length,
  };
}

if (results.A && results.B) {
  console.log(`\n${"═".repeat(70)}`);
  console.log("  量化对比");
  console.log(`${"═".repeat(70)}\n`);
  console.log("  角色      A 记忆   B 记忆    A 长期   B 长期");
  for (let i = 0; i < results.A.characters.length; i++) {
    const a = results.A.characters[i];
    const b = results.B.characters[i];
    const aLong = a.memories.filter((m) => m.isLongTerm).length;
    const bLong = b.memories.filter((m) => m.isLongTerm).length;
    console.log(
      `  ${a.name.padEnd(8)} ${String(a.memories.length).padStart(4)}  ` +
        `${String(b.memories.length).padStart(6)}   ` +
        `${String(aLong).padStart(5)}  ${String(bLong).padStart(6)}`,
    );
  }
  if (results.A2) {
    console.log("\n  （A2 是同样规则的第二遍，作为随机性基线）");
    for (let i = 0; i < results.A.characters.length; i++) {
      const c = results.A2.characters[i];
      const long = c.memories.filter((m) => m.isLongTerm).length;
      console.log(
        `  ${c.name.padEnd(8)} ${String(c.memories.length).padStart(4)}  ` +
          `${"".padStart(6)}   ${String(long).padStart(5)}  ${"".padStart(6)}`,
      );
    }
  }
  console.log(
    `\n  A 事件 ${results.A.events.length} 个 / B 事件 ${results.B.events.length} 个`,
  );
  console.log(
    `  A 调用 ${results.A.okCalls} 次（失败 ${results.A.failCalls}）/ ` +
      `B 调用 ${results.B.okCalls} 次（失败 ${results.B.failCalls}）`,
  );
  console.log(
    "\n  ⚠️ 真 LLM 每次跑结果都不同 —— 上面的数字是**这一次**的，" +
      "\n     不是两次运行的稳定差异。判断「规则有没有效」要看**内容**是否对得上。",
  );

  // ── 差异程度：随机性基线 vs 规则影响 ──
  console.log(`\n${"═".repeat(70)}`);
  console.log("  差异程度对比");
  console.log("  （A2 是同样规则的第二遍 —— 它代表「纯随机性」造成多大差异）");
  console.log(`${"═".repeat(70)}\n`);
  const aa = results.A2 ? diffDegree(results.A, results.A2) : null;
  const ab = diffDegree(results.A, results.B);
  const rows = [
    ["A vs A2（同样规则 = 纯随机性）", aa],
    ["A vs B（改了规则）", ab],
  ];
  console.log("  对比                       记忆条数      记忆内容重合   对话文字重合");
  for (const [label, d] of rows) {
    if (!d) continue;
    console.log(
      `  ${label.padEnd(26)}  ${String(d.memCountA).padStart(3)}→${String(d.memCountB).padEnd(3)}` +
        `      ${(d.jaccard * 100).toFixed(0).padStart(3)}%` +
        `         ${(d.turnOverlap * 100).toFixed(0).padStart(3)}%`,
    );
  }
  if (aa) {
    console.log();
    if (ab.jaccard < aa.jaccard) {
      console.log(
        "  ✅ 改了规则之后，记忆内容重合度**低于**纯随机性的基线 ——" +
          "\n     说明规则的影响**大于** LLM 随机性。",
      );
    } else {
      console.log(
        "  ⚠️ 改了规则之后，记忆内容重合度**不低于**纯随机性的基线 ——" +
          "\n     在这个规模上，规则的影响被 LLM 随机性盖住了。" +
          "\n     这不代表规则没生效（严格对照那一段能证明），" +
          "\n     只说明「读内容」这个尺子在这个规模上不够灵敏。",
      );
    }
  }

  // 检索对比 —— 这一段**不受 LLM 随机性干扰**
  // （检索是纯计算，同样的记忆库必然得到同样的结果）
  console.log(`\n${"─".repeat(70)}`);
  console.log("  检索对比（纯计算，不受 LLM 随机性影响）");
  console.log(`${"─".repeat(70)}\n`);
  for (let i = 0; i < results.A.retrieval.length; i++) {
    const a = results.A.retrieval[i];
    const b = results.B.retrieval[i];
    for (let j = 0; j < a.aboutOthers.length; j++) {
      const ao = a.aboutOthers[j];
      const bo = b.aboutOthers[j];
      const same =
        JSON.stringify(ao.contents) === JSON.stringify(bo.contents);
      if (ao.contents.length === 0 && bo.contents.length === 0) continue;
      console.log(`  ${a.name} 关于 ${ao.about}：${same ? "⚪ 相同" : "✅ 不同"}`);
      if (!same) {
        console.log("    A：");
        for (const c of ao.contents) console.log(`      · ${c}`);
        console.log("    B：");
        for (const c of bo.contents) console.log(`      · ${c}`);
      }
    }
  }

  // ── 严格对照 ──
  // 同一份记忆库（A 组跑出来的），只换规则，重算检索。
  // 唯一的变量是规则 —— 这是最干净的证据。
  console.log(`\n${"═".repeat(70)}`);
  console.log("  严格对照：同一份记忆库，只换规则重算检索");
  console.log("  （唯一的变量是规则 —— 检索是纯计算，不受 LLM 随机性影响）");
  console.log(`${"═".repeat(70)}\n`);
  let strictDiffs = 0;
  for (const sc of results.A.strictControl) {
    const same =
      JSON.stringify(sc.underA) === JSON.stringify(sc.underB);
    if (same) {
      if (sc.underA.length > 0) {
        console.log(`  ⚪ 相同  ${sc.who} 关于 ${sc.about}`);
      }
      continue;
    }
    strictDiffs++;
    console.log(`  ✅ 不同  ${sc.who} 关于 ${sc.about}`);
    console.log("    默认规则：");
    for (const c of sc.underA) console.log(`      · ${c}`);
    console.log("    改动规则：");
    for (const c of sc.underB) console.log(`      · ${c}`);
  }
  console.log(
    `\n  ${strictDiffs} 处检索结果不同 —— 规则**直接**改变了「谁关于谁的哪些记忆进 prompt」。`,
  );
}

console.log("\n原世界未被改动（每组都在临时副本上跑）。");
