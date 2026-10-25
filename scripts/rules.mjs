#!/usr/bin/env node
/**
 * 世界规则 CLI —— 「世界可控 L2」的操作界面。
 *
 * 用法：
 *   npm run rules -- show [--world <worldId>]
 *   npm run rules -- show <characterId> [--world <worldId>]
 *   npm run rules -- set <path> <value> [--world <worldId>]
 *   npm run rules -- set <characterId> <path> <value> [--world <worldId>]
 *   npm run rules -- reset [<path>] [--world <worldId>]
 *   npm run rules -- reset <characterId> [<path>] [--world <worldId>]
 *   npm run rules -- list [--world <worldId>]
 *   npm run rules -- design-keys
 *
 * 路径写法：`emotion.decayRate`、`memory.recencyDecayRate`。
 * 角色级 override 前面加角色 id：`wang_damai emotion.decayRate 0.8`。
 *
 * 不传 `--world` 时用「当前世界」= 最近改动的生成世界。
 *
 * ## 为什么规则写进 world.json 而不是单独一个文件
 *
 * 因为**规则是这个世界的一部分**。跟世界一起存、一起复制、一起版本管理，
 * 比放在某个全局配置文件里更不容易走散 —— 换世界时规则跟着换。
 *
 * ## 写完为什么不自动重载
 *
 * server 进程里的规则是启动时读进内存的。改完 world.json 后，
 * server 需要重新加载才生效（`POST /api/world/reload` 或重启）。
 * CLI 会提示这一点，但**不主动去碰 server** —— CLI 不该有副作用到运行中的进程上。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, "..");
const GENERATED_WORLDS_DIR = path.join(PROJECT_DIR, "output", "worlds");
const LIBRARY_WORLDS_DIR = path.join(PROJECT_DIR, "library", "worlds");

// core 的规则类型和校验逻辑是 TypeScript —— 用 tsx 加载。
// 走 dist/ 的话要先构建；这里直接吃源码，跟 vitest 走的是同一份逻辑。
const CORE_ENTRY = path.join(PROJECT_DIR, "packages", "core", "src", "engine", "rules.ts");

const args = process.argv.slice(2);

function arg(flag, fallback = null) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--")
    ? args[i + 1]
    : fallback;
}
const has = (flag) => args.includes(flag);

/**
 * 去掉 flag 和**命令名**，留下位置参数。
 *
 * 命令名是 args[0]（`show` / `set` / ...），不是位置参数 ——
 * 不去掉的话 `npm run rules -- show` 会把 "show" 当成角色 id。
 */
function positionalArgs() {
  const out = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      // 带值的 flag 跳过它的值
      if (i + 1 < args.length && !args[i + 1].startsWith("--")) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

// ─── 加载 core 的规则逻辑 ─────────────────────────────────────────────────

let coreRules;
async function loadCoreRules() {
  if (coreRules) return coreRules;
  const { tsImport } = await import("tsx/esm/api");
  const mod = await tsImport(
    pathToFileURL(CORE_ENTRY).href,
    import.meta.url,
  );
  coreRules = mod;
  return coreRules;
}

// ─── 找世界目录 ──────────────────────────────────────────────────────────

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

function resolveWorldDir(worldId) {
  // --world 可以给**世界 id**（output/worlds 里的目录名），
  // 也可以给**路径**（绝对或相对仓库根）。
  // 给路径是必要的：测试世界常在仓库外的临时目录里。
  if (worldId) {
    const asPath = path.resolve(PROJECT_DIR, worldId);
    if (fs.existsSync(asPath) && fs.statSync(asPath).isDirectory()) {
      if (
        fs.existsSync(path.join(asPath, "world.json")) ||
        fs.existsSync(path.join(asPath, "config", "world.json"))
      ) {
        return asPath;
      }
    }
    const dirs = listWorldDirs();
    const found = dirs.find((d) => path.basename(d) === worldId);
    if (!found) throw new Error(`找不到世界：${worldId}`);
    return found;
  }
  const dirs = listWorldDirs();
  if (dirs.length === 0) throw new Error("没有任何世界");
  // 最近的生成世界优先
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

function charactersDir(worldDir) {
  for (const p of [
    path.join(worldDir, "config", "characters"),
    path.join(worldDir, "characters"),
  ]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ─── 读 / 写 ─────────────────────────────────────────────────────────────

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

/** 写 JSON —— 保持 2 空格缩进，跟仓库里其它 world.json 一致。 */
function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

// ─── 路径寻址 ────────────────────────────────────────────────────────────

/**
 * 规则路径的别名。
 *
 * ROADMAP 里写的命令示例是 `set emotion.decay 0.9`，
 * 但实际规则名是 `emotion.decayRate`（跟 `recencyDecayRate` 等保持一致的命名）。
 * 别名让文档里的命令能直接用，同时落盘时用**规范名**。
 *
 * 别名 → 规范名。别名只认一个组内的简写，不做模糊匹配 ——
 * 模糊匹配会让「打错字」变成「静默改错规则」，那比报错更糟。
 */
const RULE_ALIASES = {
  "emotion.decay": "emotion.decayRate",
  "emotion.weight": "emotion.valenceCurrentWeight",
  "memory.decay": "memory.recencyDecayRate",
  "memory.forget": "memory.recencyDecayRate",
  "perception.threshold": "perception.visibleValenceThreshold",
};

/**
 * 把 `组.键` 拆成组名和键名。
 * 写错组名要报错 —— 不能默默建一个新组。
 */
function parseRulePath(rulePath, groups) {
  const canonical = RULE_ALIASES[rulePath] ?? rulePath;
  const parts = canonical.split(".");
  if (parts.length !== 2) {
    throw new Error(
      `规则路径要写成「组.键」，比如 emotion.decayRate（收到：${rulePath}）`,
    );
  }
  const [group, key] = parts;
  if (!groups.includes(group)) {
    throw new Error(
      `没有规则组「${group}」。可用：${groups.join(", ")}`,
    );
  }
  return { group, key };
}

function getRuleValue(rules, group, key) {
  return rules[group]?.[key];
}

function setRuleValue(rawRules, group, key, value) {
  // rawRules 是**部分规则**（world.json 里存的样子），不是合并后的完整规则
  if (!rawRules || typeof rawRules !== "object") rawRules = {};
  if (!rawRules[group] || typeof rawRules[group] !== "object") {
    rawRules[group] = {};
  }
  rawRules[group][key] = value;
  return rawRules;
}

// ─── 命令 ────────────────────────────────────────────────────────────────

async function cmdShow() {
  const positional = positionalArgs();
  const worldDir = resolveWorldDir(arg("--world"));
  const core = await loadCoreRules();
  const raw = readJson(worldJsonPath(worldDir));

  if (positional.length > 0) {
    // 角色级
    const charId = positional[0];
    const charPath = findCharacterFile(worldDir, charId);
    if (!charPath) {
      throw new Error(`找不到角色：${charId}`);
    }
    const charConfig = readJson(charPath);
    const worldRules = core.mergeRules(raw.rules);
    const charRules = core.mergeRules(charConfig.rules, worldRules);

    console.log(`世界：${path.basename(worldDir)}`);
    console.log(
      `角色：${charConfig.name ?? "?"}（${charConfig.id ?? charId}）\n`,
    );
    printRules(charRules, worldRules, core);
    return;
  }

  console.log(`世界：${path.basename(worldDir)}（${raw.worldName ?? "?"}）\n`);
  const worldRules = core.mergeRules(raw.rules);
  printRules(worldRules, null, core);

  if (!raw.rules || Object.keys(raw.rules).length === 0) {
    console.log("\n（world.json 里还没写 rules 段 —— 现在用的全是默认值）");
  }
}

/**
 * 打印规则，标出哪些是改过的。
 *
 * @param effective 生效的完整规则
 * @param base 对照基准（角色级时传世界级，用来标出角色自己改了什么）
 */
function printRules(effective, base, core) {
  for (const group of core.RULE_GROUPS) {
    console.log(`【${group}】`);
    for (const [key, value] of Object.entries(effective[group])) {
      const overridden = base && base[group]?.[key] !== value;
      const marker = overridden ? "  ← 改过" : "";
      const baseText = overridden ? `（世界级：${base[group][key]}）` : "";
      console.log(`  ${key} = ${value}${baseText}${marker}`);
    }
    console.log("");
  }
}

async function cmdSet() {
  const positional = positionalArgs();
  const worldDir = resolveWorldDir(arg("--world"));
  const core = await loadCoreRules();

  let charId = null;
  let rulePath;
  let rawValue;

  if (positional.length === 3) {
    // 角色级：<characterId> <path> <value>
    [charId, rulePath, rawValue] = positional;
  } else if (positional.length === 2) {
    // 世界级：<path> <value>
    [rulePath, rawValue] = positional;
  } else {
    throw new Error("用法：npm run rules -- set <path> <value>  或  set <characterId> <path> <value>");
  }

  const { group, key } = parseRulePath(rulePath, core.RULE_GROUPS);

  // 校验键名存在 —— 拼错了要当场报错
  const defaults = core.DEFAULT_RULES;
  if (!(key in defaults[group])) {
    throw new Error(
      `规则「${group}」里没有「${key}」。可用：` +
        Object.keys(defaults[group]).join(", "),
    );
  }

  const value = Number(rawValue);
  if (!Number.isFinite(value)) {
    throw new Error(`规则值必须是数字，收到：${rawValue}`);
  }

  if (charId) {
    const charPath = findCharacterFile(worldDir, charId);
    if (!charPath) throw new Error(`找不到角色：${charId}`);
    const charConfig = readJson(charPath);
    charConfig.rules = setRuleValue(
      charConfig.rules,
      group,
      key,
      value,
    );
    writeJson(charPath, charConfig);
    console.log(
      `已设置角色 ${charId}：${rulePath} = ${value}  (${charPath})`,
    );
  } else {
    const jsonPath = worldJsonPath(worldDir);
    const raw = readJson(jsonPath);
    raw.rules = setRuleValue(raw.rules, group, key, value);
    writeJson(jsonPath, raw);
    console.log(`已设置世界规则：${rulePath} = ${value}  (${jsonPath})`);
  }

  // 校验一下这个值合不合理。
  //
  // 用 `validateRawRules` 校验**原始**片段，而不是 `validateRules`
  // 校验合并后的完整规则 —— 合并时越界的值已经被夹回区间，
  // 再去校验合并结果就看不到「你填的值越界了」这个事实了。
  const checkRaw = charId
    ? readJson(findCharacterFile(worldDir, charId)).rules
    : readJson(worldJsonPath(worldDir)).rules;
  const issues = core.validateRawRules(checkRaw);
  if (issues.length > 0) {
    console.log("\n⚠ 这个值让规则变得不合理：");
    for (const issue of issues) console.log(`  - ${issue}`);
    console.log(
      "\n  提示：越界的值会被引擎夹回合理区间 —— 世界不会崩，" +
        "但你填的数不会完全生效。",
    );
  }

  console.log(
    "\n提示：server 进程里的规则是启动时读的，改完需要重载" +
      "（POST /api/world/reload）或重启 server 才生效。",
  );
}

async function cmdReset() {
  const positional = positionalArgs();
  const worldDir = resolveWorldDir(arg("--world"));
  const core = await loadCoreRules();

  let charId = null;
  let rulePath = null;

  if (positional.length === 2) {
    [charId, rulePath] = positional;
  } else if (positional.length === 1) {
    // 单个参数既可能是角色 id 也可能是规则路径
    const only = positional[0];
    if (core.RULE_GROUPS.includes(only.split(".")[0])) {
      rulePath = only;
    } else {
      charId = only;
    }
  } else if (positional.length === 0) {
    // 全部重置
  } else {
    throw new Error("用法：npm run rules -- reset [<characterId>] [<path>]");
  }

  if (charId) {
    const charPath = findCharacterFile(worldDir, charId);
    if (!charPath) throw new Error(`找不到角色：${charId}`);
    const charConfig = readJson(charPath);

    if (!rulePath) {
      delete charConfig.rules;
      console.log(`已清空角色 ${charId} 的全部规则覆盖  (${charPath})`);
    } else {
      const { group, key } = parseRulePath(rulePath, core.RULE_GROUPS);
      if (charConfig.rules?.[group]) {
        delete charConfig.rules[group][key];
        if (Object.keys(charConfig.rules[group]).length === 0) {
          delete charConfig.rules[group];
        }
      }
      if (
        charConfig.rules &&
        Object.keys(charConfig.rules).length === 0
      ) {
        delete charConfig.rules;
      }
      console.log(
        `已重置角色 ${charId} 的 ${rulePath} → 回到世界级  (${charPath})`,
      );
    }
    writeJson(charPath, charConfig);
  } else {
    const jsonPath = worldJsonPath(worldDir);
    const raw = readJson(jsonPath);

    if (!rulePath) {
      delete raw.rules;
      console.log(`已清空世界全部规则  (${jsonPath})`);
    } else {
      const { group, key } = parseRulePath(rulePath, core.RULE_GROUPS);
      if (raw.rules?.[group]) {
        delete raw.rules[group][key];
        if (Object.keys(raw.rules[group]).length === 0) {
          delete raw.rules[group];
        }
      }
      if (raw.rules && Object.keys(raw.rules).length === 0) {
        delete raw.rules;
      }
      console.log(`已重置世界规则 ${rulePath} → 回到默认值  (${jsonPath})`);
    }
    writeJson(jsonPath, raw);
  }
}

async function cmdList() {
  const worldDir = resolveWorldDir(arg("--world"));
  const core = await loadCoreRules();

  console.log("可用规则：\n");
  for (const group of core.RULE_GROUPS) {
    console.log(`【${group}】`);
    for (const [key, value] of Object.entries(core.DEFAULT_RULES[group])) {
      console.log(`  ${group}.${key} = ${value}`);
    }
    console.log("");
  }
}

/**
 * 打印世界设计可用的规则键（白名单）—— 提示词里那份清单的**来源**。
 *
 * ## 为什么有这个命令
 *
 * `prompts/world-creation.md` 里列的规则名以前是手写的，
 * 跟 core 的 `DEFAULT_RULES` 各维护一份。必然漂移，而且漂得隐蔽：
 * 少一个键，LLM 用不上那个旋钮；多一个（拼错的）键，
 * `mergeRules` 静默忽略，LLM 以为改了规则其实没改。
 *
 * 现在白名单是 core 里的**数据**（`WORLD_DESIGN_RULE_KEYS`），
 * 这个命令把它打出来 —— 加了新规则之后，
 * 照着输出改提示词就行，不用自己回忆有哪些。
 *
 * ## 注意
 *
 * 提示词里每个键还带一句「这个旋钮拧了会怎样」的说明。
 * 那部分**是手写的**，工具生成不了 —— 但**键名和默认值**能。
 */
async function cmdDesignKeys() {
  const core = await loadCoreRules();

  const issues = core.validateWorldDesignRuleKeys?.() ?? [];
  if (issues.length > 0) {
    console.error("白名单有问题：");
    for (const i of issues) console.error(`  ❌ ${i}`);
    process.exit(1);
  }

  console.log("世界设计可用的规则（提示词清单的来源）：\n");
  for (const group of core.RULE_GROUPS) {
    const keys = core.WORLD_DESIGN_RULE_KEYS[group] ?? [];
    const defs = core.DEFAULT_RULES[group];
    console.log(`【${group}】`);
    for (const key of keys) {
      console.log(`  ${key}（默认 ${defs[key]}）`);
    }
    console.log("");
  }

  const total = Object.values(core.WORLD_DESIGN_RULE_KEYS).reduce(
    (n, ks) => n + ks.length,
    0,
  );
  const all = Object.values(core.DEFAULT_RULES).reduce(
    (n, g) => n + Object.keys(g).length,
    0,
  );
  console.log(`白名单 ${total} 个 / 全部 ${all} 个`);
  console.log(
    "（白名单外的键是引擎内部细节或取值范围，不给 LLM —— 见 rules.ts 的注释）",
  );
}

function findCharacterFile(worldDir, charIdOrName) {
  const dir = charactersDir(worldDir);
  if (!dir) return null;
  const direct = path.join(dir, `${charIdOrName}.json`);
  if (fs.existsSync(direct)) return direct;
  // 兜底：按文件里的 id 或 name 找
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const p = path.join(dir, name);
    try {
      const data = readJson(p);
      if (data.id === charIdOrName || data.name === charIdOrName) {
        return p;
      }
    } catch {
      // 坏文件跳过
    }
  }
  return null;
}

// ─── 入口 ────────────────────────────────────────────────────────────────

const COMMANDS = {
  show: cmdShow,
  set: cmdSet,
  reset: cmdReset,
  list: cmdList,
  "design-keys": cmdDesignKeys,
};

const command = args[0];
if (!command || !COMMANDS[command]) {
  console.error("用法：npm run rules -- <show|set|reset|list|design-keys> ...");
  console.error("");
  console.error("  show                              列出当前世界的规则");
  console.error("  show <characterId>                列出某角色生效的规则");
  console.error("  set <path> <value>                改世界规则，如 set emotion.decayRate 0.9");
  console.error("  set <characterId> <path> <value>  改角色级 override");
  console.error("  reset [<path>]                    重置世界规则（不写路径 = 全部重置）");
  console.error("  reset <characterId> [<path>]      重置角色级 override");
  console.error("  list                              列出所有可用规则和默认值");
  console.error("  design-keys                       列出世界设计可用的规则（提示词清单的来源）");
  console.error("");
  console.error("通用选项：--world <worldId>");
  process.exit(1);
}

try {
  await COMMANDS[command]();
} catch (err) {
  console.error(`错误：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
