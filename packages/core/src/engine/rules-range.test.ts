import { describe, it, expect } from "vitest";
import {
  DEFAULT_RULES,
  RULE_GROUPS,
  RULE_RANGES,
  clampRuleValue,
  mergeRules,
  validateRawRules,
  validateRules,
} from "./rules.js";
import { decayEmotion, getEmotionLabel } from "./emotion-manager.js";

/**
 * 规则值的**范围钳制** —— 审阅阶段 2.5 时补的。
 *
 * ## 为什么要这一层
 *
 * 规则值有三条入口，全是外部输入：
 *
 * | 入口 | 谁能写 |
 * |---|---|
 * | `world.json` 的 `rules` 段 | 人手写、插件写 |
 * | 角色配置的 `rules` 段 | 人手写、插件写 |
 * | 世界设计流程 | **LLM 直出** |
 *
 * 提示词里写「0-1，默认 0.95」是**建议**，不是**保证**。
 * LLM 会给出 1.8，插件作者也会写错。
 *
 * 而越界的值**不会报错**，只会让世界**静默崩坏**。实测：
 *
 * ```
 * decayRate = 1.8 → 6 个 tick 后效价从 3 涨到 46875，全程零报错
 * ```
 *
 * 抽规则这一阶段最该防的就是这类 bug ——
 * **抽错了不报错，只让行为悄悄漂移**。
 * 规则抽出来之后，「改错了不报错」的风险从代码搬到了数据里。
 * 这一层就是把那条防线补回来。
 */

describe("RULE_RANGES —— 范围表必须覆盖每一个规则参数", () => {
  it("37 个参数一个不漏", () => {
    const allKeys: string[] = [];
    for (const group of RULE_GROUPS) {
      for (const key of Object.keys(DEFAULT_RULES[group])) {
        allKeys.push(`${group}.${key}`);
      }
    }
    expect(allKeys).toHaveLength(37);

    const missing = allKeys.filter((k) => !(k in RULE_RANGES));
    expect(missing).toEqual([]);
  });

  it("范围表里没有多余的键（写错的键名会暴露）", () => {
    const allKeys: string[] = [];
    for (const group of RULE_GROUPS) {
      for (const key of Object.keys(DEFAULT_RULES[group])) {
        allKeys.push(`${group}.${key}`);
      }
    }
    const extra = Object.keys(RULE_RANGES).filter((k) => !allKeys.includes(k));
    expect(extra).toEqual([]);
  });

  it("每个默认值都在自己的范围内（否则默认世界本身就是坏的）", () => {
    for (const group of RULE_GROUPS) {
      const groupRules = DEFAULT_RULES[group] as unknown as Record<string, number>;
      for (const [key, value] of Object.entries(groupRules)) {
        const range = RULE_RANGES[`${group}.${key}`]!;
        if (range.min !== undefined) {
          expect(value).toBeGreaterThanOrEqual(range.min);
        }
        if (range.max !== undefined) {
          expect(value).toBeLessThanOrEqual(range.max);
        }
      }
    }
  });

  it("validateRules 检得出越界的值（范围表真的接上了）", () => {
    // 之前有 13 个参数 validateRules 根本没检查
    const unchecked = [
      "emotion.strongValenceThreshold",
      "emotion.strongArousalThreshold",
      "emotion.mildArousalThreshold",
      "emotion.boredArousalThreshold",
      "memory.relatedCharacterBonus",
      "memory.relatedLocationBonus",
      "memory.accessStrengthBonus",
      "memory.deleteAfterDays",
      "memory.fadeAfterDays",
      "memory.faintAfterDays",
      "memory.consolidateImportance",
      "memory.consolidateAccessCount",
      "memory.referencedDecayFactor",
    ];
    for (const path of unchecked) {
      const [group, key] = path.split(".");
      const bad = { ...DEFAULT_RULES[group] } as Record<string, number>;
      bad[key] = -999;
      const merged = { ...DEFAULT_RULES, [group]: bad } as typeof DEFAULT_RULES;
      expect(
        validateRules(merged).join("\n"),
        `${path} 越界了却没被报出来`,
      ).toContain(path);
    }
  });
});

describe("clampRuleValue —— 越界的值夹回区间", () => {
  it("超过上限夹到上限", () => {
    expect(clampRuleValue(1.8, { min: 0, max: 1 })).toBe(1);
  });

  it("低于下限夹到下限", () => {
    expect(clampRuleValue(-0.5, { min: 0, max: 1 })).toBe(0);
  });

  it("区间内的值不动", () => {
    expect(clampRuleValue(0.42, { min: 0, max: 1 })).toBe(0.42);
  });

  it("整数参数会被取整", () => {
    expect(clampRuleValue(3.7, { min: 0, max: 100, integer: true })).toBe(4);
  });
});

describe("mergeRules —— 越界的值不会进到规则里", () => {
  it("decayRate=1.8 被夹到 1", () => {
    const m = mergeRules({ emotion: { decayRate: 1.8 } });
    expect(m.emotion.decayRate).toBe(1);
  });

  it("decayRate=-1 被夹到 0", () => {
    const m = mergeRules({ emotion: { decayRate: -1 } });
    expect(m.emotion.decayRate).toBe(0);
  });

  it("权重 >1 被夹到 1", () => {
    const m = mergeRules({
      emotion: { valenceCurrentWeight: 3, valenceEventWeight: 3 },
    });
    expect(m.emotion.valenceCurrentWeight).toBe(1);
    expect(m.emotion.valenceEventWeight).toBe(1);
  });

  it("天数参数被取整", () => {
    const m = mergeRules({ memory: { deleteAfterDays: 7.6 } });
    expect(m.memory.deleteAfterDays).toBe(8);
  });

  it("longActionMinutes=0 被夹到 1（不能是 0 —— 那会让所有动作都算长动作）", () => {
    const m = mergeRules({ action: { longActionMinutes: 0 } });
    expect(m.action.longActionMinutes).toBe(1);
  });

  it("合法的值一个都不动", () => {
    const m = mergeRules({
      emotion: { decayRate: 0.8 },
      memory: { consolidateImportance: 9 },
    });
    expect(m.emotion.decayRate).toBe(0.8);
    expect(m.memory.consolidateImportance).toBe(9);
  });

  it("钳制不改变默认值（默认规则全部在自己的范围内）", () => {
    const m = mergeRules({});
    expect(m).toEqual(DEFAULT_RULES);
  });
});

describe("越界的规则不会让世界崩坏", () => {
  it("decayRate=1.8 不会让效价爆掉（这是修这个 bug 的原因）", () => {
    const m = mergeRules({ emotion: { decayRate: 1.8 } });
    let valence = 3;
    let arousal = 5;
    for (let tick = 0; tick < 6; tick++) {
      const d = decayEmotion({ valence, arousal }, m.emotion);
      valence = d.valence;
      arousal = d.arousal;
    }
    // 修之前这里是 46875 —— 世界静默崩坏，全程零报错
    expect(Math.abs(valence)).toBeLessThanOrEqual(5);
    expect(arousal).toBeLessThanOrEqual(10);
  });

  it("文案不会因为越界值变成胡说八道", () => {
    const m = mergeRules({ emotion: { decayRate: 1.8 } });
    const d = decayEmotion({ valence: 3, arousal: 5 }, m.emotion);
    expect(getEmotionLabel(d.valence, d.arousal, m.emotion)).toMatch(
      /平静|满足|兴奋|不满|生气|紧张|无聊|愉快|沮丧|平静/,
    );
  });
});

describe("validateRawRules —— 校验用户原样填的值", () => {
  it("越界的值能被报出来（钳制之前的证据）", () => {
    const issues = validateRawRules({ emotion: { decayRate: 1.8 } });
    expect(issues.join("\n")).toContain("emotion.decayRate");
  });

  it("拼错的键名会被报出来（它会被 mergeRules 静默忽略）", () => {
    const issues = validateRawRules({ emotion: { decayRat: 0.5 } });
    expect(issues.join("\n")).toContain("decayRat");
  });

  it("类型错的会被报出来（字符串 '0.2' 会被 mergeRules 忽略）", () => {
    const issues = validateRawRules({ emotion: { decayRate: "0.2" } });
    expect(issues.join("\n")).toContain("emotion.decayRate");
  });

  it("合法的值没有问题", () => {
    expect(validateRawRules({ emotion: { decayRate: 0.8 } })).toEqual([]);
  });

  it("部分规则片段只检查它写了的（没写的继承世界级，不用报）", () => {
    expect(validateRawRules({ emotion: { decayRate: 0.8 } })).toEqual([]);
  });

  it("形状不对的输入不报错（不是规则的职责）", () => {
    expect(validateRawRules(null)).toEqual([]);
    expect(validateRawRules([])).toEqual([]);
    expect(validateRawRules("垃圾")).toEqual([]);
  });
});
