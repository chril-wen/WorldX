import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_RULES,
  RULE_GROUPS,
  WORLD_DESIGN_RULE_KEYS,
  validateWorldDesignRuleKeys,
} from "../../packages/core/src/engine/rules.js";

/**
 * 提示词里的规则名清单，跟 core 的规则层**不能各维护一份**。
 *
 * ## 为什么这个测试重要
 *
 * `prompts/world-creation.md` 里列着「世界设计能用哪些规则」。
 * 以前那份清单是**手写**的，跟 `DEFAULT_RULES` 各维护一份。
 *
 * 漂移的方向都很隐蔽：
 * - 少一个键 → LLM 永远用不上那个旋钮（世界造不出那种气质）
 * - 多一个键（拼错的）→ `mergeRules` **静默忽略**它 →
 *   LLM 以为自己改了规则，其实什么都没发生，而且**不报错**
 *
 * 所以：白名单在 core 里是**数据**，提示词从它生成，
 * 这个测试校验提示词跟它一致。
 *
 * ## 一个刻意的设计
 *
 * 白名单**不等于**全部规则（32 vs 37）。白名单外的 5 个是：
 * - 情绪的取值范围（`valenceMin` / `arousalMax` 之类）——
 *   引擎的硬边界，不是「世界的气质」
 * - `referencedDecayFactor` —— 引擎内部细节
 *
 * 让 LLM 去调这些没有好处。所以「提示词里没有某个键」本身不是 bug，
 * **但必须是白名单里明确排除的** —— 这个测试管的就是这件事。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const PROMPT_PATH = join(REPO_ROOT, "prompts", "world-creation.md");

/** 提示词里 `rules` 那一段。 */
function getRulesSection(prompt: string): string {
  const start = prompt.indexOf("`rules`（对象");
  expect(start, "提示词里找不到 rules 段").toBeGreaterThan(-1);
  // 到下一个空行为止
  const rest = prompt.slice(start);
  const end = rest.indexOf("\n\n");
  return end > 0 ? rest.slice(0, end) : rest;
}

/**
 * 抽出提示词里列的键。
 *
 * 格式是：`- \`组\`：\`键1\`（说明）、\`键2\`（说明）`
 * 键名是反引号包着的。
 */
function parsePromptKeys(prompt: string): Set<string> {
  const section = getRulesSection(prompt);
  const keys = new Set<string>();
  for (const line of section.split("\n")) {
    const groupMatch = line.match(/^\s*-\s*`(\w+)`：/);
    if (!groupMatch) continue;
    const group = groupMatch[1];
    for (const m of line.matchAll(/`(\w+)`/g)) {
      if (m[1] === group) continue;
      keys.add(`${group}.${m[1]}`);
    }
  }
  return keys;
}

describe("提示词的规则清单跟 core 的白名单一致", () => {
  const prompt = readFileSync(PROMPT_PATH, "utf-8");
  const promptKeys = parsePromptKeys(prompt);

  it("白名单里的键都真实存在（写错了要在这里暴露）", () => {
    expect(validateWorldDesignRuleKeys()).toEqual([]);
  });

  it("提示词列的键 == 白名单里的键", () => {
    const whitelist = new Set<string>();
    for (const group of RULE_GROUPS) {
      for (const key of WORLD_DESIGN_RULE_KEYS[group]) {
        whitelist.add(`${group}.${key}`);
      }
    }

    const missing = [...whitelist].filter((k) => !promptKeys.has(k));
    const extra = [...promptKeys].filter((k) => !whitelist.has(k));

    // 少了 → LLM 用不上那个旋钮
    expect(missing, "提示词漏了白名单里的键").toEqual([]);
    // 多了 → 可能是拼错的，会被 mergeRules 静默忽略
    expect(extra, "提示词里有白名单外的键（拼错了？）").toEqual([]);
  });

  it("提示词里写的默认值跟 rules.ts 一致", () => {
    // 这是最容易悄悄漂的一处 —— 提示词里的「默认 0.95」跟代码里的
    // 0.95 分家了，LLM 看到的和引擎用的就不是一回事。
    const section = getRulesSection(prompt);
    let checked = 0;

    for (const group of RULE_GROUPS) {
      for (const key of WORLD_DESIGN_RULE_KEYS[group]) {
        const idx = section.indexOf(`\`${key}\``);
        expect(idx, `提示词里找不到 ${group}.${key}`).toBeGreaterThan(-1);

        // 从键名往后看 200 个字符，找「默认 N」
        const tail = section.slice(idx, idx + 200);
        const m = tail.match(/默认\s*([0-9]+(?:\.[0-9]+)?)/);
        expect(m, `${group}.${key} 在提示词里没写默认值`).toBeTruthy();

        const stated = Number(m![1]);
        const actual = DEFAULT_RULES[group][key as keyof typeof DEFAULT_RULES[typeof group]];
        expect(
          stated,
          `${group}.${key} 的默认值漂了：提示词说 ${stated}，rules.ts 是 ${actual}`,
        ).toBe(actual);
        checked++;
      }
    }

    // 确认真的检查到了 —— 防止上面的循环因为某种原因空转
    expect(checked).toBeGreaterThan(30);
  });

  it("白名单外的键是「故意不给 LLM 的」，不是漏的", () => {
    // 把每个键归类：白名单内 / 白名单外
    // 白名单外的必须能说出理由 —— 这里锁住具体是哪几个，
    // 将来有人想加进白名单，得先改这里。
    const outside = new Set<string>();
    for (const group of RULE_GROUPS) {
      const allowed = new Set(WORLD_DESIGN_RULE_KEYS[group]);
      for (const key of Object.keys(DEFAULT_RULES[group])) {
        if (!allowed.has(key)) outside.add(`${group}.${key}`);
      }
    }

    // 引擎硬边界（取值范围）+ 内部细节
    expect([...outside].sort()).toEqual([
      "emotion.arousalMax",
      "emotion.arousalMin",
      "emotion.valenceMax",
      "emotion.valenceMin",
      "memory.referencedDecayFactor",
    ]);
  });
});
