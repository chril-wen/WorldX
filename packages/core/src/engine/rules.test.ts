import { describe, it, expect } from "vitest";
import {
  DEFAULT_RULES,
  RULE_GROUPS,
  cloneRules,
  mergeRules,
  validateRules,
} from "./rules.js";
import { updateEmotion, decayEmotion, getEmotionLabel } from "./emotion-manager.js";
import { decayNeeds } from "./needs-manager.js";
import type { CharacterState, CharacterProfile } from "../contracts/index.js";

/**
 * 规则层回归 —— **锁住「改造前后行为完全一致」**。
 *
 * ## 为什么这个文件这么写
 *
 * 阶段 2.5 把 30 处硬编码抽成规则，最大的风险不是写错，是**行为悄悄漂移**。
 * 抽错了不会报错，只会让世界变得跟以前不一样 —— 而这种差异要跑好几天模拟
 * 才看得出来。
 *
 * 所以这里用**改造前的字面公式**当基准（`legacy*` 函数），
 * 跟走规则的新实现逐点对比。基准是**照抄原代码**的，不是从新实现反推的。
 *
 * 任何一条对不上，说明抽取过程改错了语义。
 */

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ─── 改造前的原始实现（照抄，改动前它们是硬编码的） ───────────────────────

function legacyUpdateEmotion(
  current: { valence: number; arousal: number },
  event: { valence: number; intensity: number },
) {
  return {
    valence: clamp(current.valence * 0.7 + event.valence * 0.3, -5, 5),
    arousal: clamp(current.arousal * 0.8 + event.intensity * 0.2, 0, 10),
  };
}

function legacyDecayEmotion(current: { valence: number; arousal: number }) {
  return {
    valence: current.valence * 0.95,
    arousal: current.arousal * 0.95 + 3 * 0.05,
  };
}

function legacyGetEmotionLabel(valence: number, arousal: number): string {
  if (arousal >= 6) {
    if (valence >= 2) return "兴奋";
    if (valence <= -2) return "愤怒";
    return "紧张";
  }
  if (arousal >= 3) {
    if (valence >= 2) return "满足";
    if (valence <= -2) return "沮丧";
    return "平静";
  }
  if (valence >= 2) return "安宁";
  if (valence <= -2) return "悲伤";
  if (arousal <= 1) return "无聊";
  return "平静";
}

const LEGACY_STRENUOUS = ["explore", "work", "exercise", "build", "repair"];

function legacyDecayNeeds(
  charState: { curiosity: number; currentAction?: string | null },
  profile: { intuitionLevel: number },
) {
  const isStrenuous = LEGACY_STRENUOUS.some((a) =>
    charState.currentAction?.includes(a),
  );
  const curiosityDelta = isStrenuous
    ? -(1 + 1.0 * profile.intuitionLevel)
    : -(0.5 + 1.0 * profile.intuitionLevel);
  return {
    curiosity: clamp(charState.curiosity + curiosityDelta, 0, 100),
  };
}

// ─── 测试脚手架 ──────────────────────────────────────────────────────────

function makeState(
  overrides: Partial<CharacterState> = {},
): CharacterState {
  return {
    characterId: "char_1",
    location: "main_area",
    mainAreaPointId: null,
    currentAction: null,
    currentActionTarget: null,
    actionStartTick: 0,
    actionEndTick: 0,
    emotionValence: 0,
    emotionArousal: 0,
    curiosity: 50,
    dailyPlan: null,
    ...overrides,
  };
}

function makeProfile(
  overrides: Partial<CharacterProfile> = {},
): CharacterProfile {
  return {
    id: "char_1",
    name: "测试角色",
    role: "测试",
    nickname: "测",
    startPosition: "main_area",
    coreMotivation: "动机",
    coreValues: [],
    speakingStyle: "普通",
    fears: [],
    preferredLocations: [],
    preferredActivities: [],
    socialStyle: "introvert",
    extraversionLevel: 0,
    intuitionLevel: 0,
    skills: [],
    writeDiary: false,
    fourthWallCandidate: false,
    tags: [],
    initialMemories: [],
    ...overrides,
  } as CharacterProfile;
}

// ─── 默认值锁定 ──────────────────────────────────────────────────────────

describe("规则默认值 —— 逐个数值对齐改造前的硬编码", () => {
  it("情绪混合权重：效价 0.7/0.3，唤醒 0.8/0.2", () => {
    expect(DEFAULT_RULES.emotion.valenceCurrentWeight).toBe(0.7);
    expect(DEFAULT_RULES.emotion.valenceEventWeight).toBe(0.3);
    expect(DEFAULT_RULES.emotion.arousalCurrentWeight).toBe(0.8);
    expect(DEFAULT_RULES.emotion.arousalEventWeight).toBe(0.2);
  });

  it("情绪取值范围与基线", () => {
    expect(DEFAULT_RULES.emotion.valenceMin).toBe(-5);
    expect(DEFAULT_RULES.emotion.valenceMax).toBe(5);
    expect(DEFAULT_RULES.emotion.arousalMin).toBe(0);
    expect(DEFAULT_RULES.emotion.arousalMax).toBe(10);
    expect(DEFAULT_RULES.emotion.arousalBaseline).toBe(3);
    expect(DEFAULT_RULES.emotion.decayRate).toBe(0.95);
  });

  it("情绪文案门限：强烈 2/6，轻微 3，无聊 1", () => {
    expect(DEFAULT_RULES.emotion.strongValenceThreshold).toBe(2);
    expect(DEFAULT_RULES.emotion.strongArousalThreshold).toBe(6);
    expect(DEFAULT_RULES.emotion.mildArousalThreshold).toBe(3);
    expect(DEFAULT_RULES.emotion.boredArousalThreshold).toBe(1);
  });

  it("需求衰减：基础 0.5，体力额外 0.5，直觉系数 1.0", () => {
    expect(DEFAULT_RULES.needs.baseDecay).toBe(0.5);
    expect(DEFAULT_RULES.needs.strenuousExtraDecay).toBe(0.5);
    expect(DEFAULT_RULES.needs.intuitionCoefficient).toBe(1.0);
  });

  it("记忆权重与衰减参数", () => {
    const m = DEFAULT_RULES.memory;
    expect(m.relevanceWeight).toBe(3);
    expect(m.recencyWeight).toBe(2);
    expect(m.importanceWeight).toBe(2);
    expect(m.emotionalIntensityWeight).toBe(1);
    expect(m.recencyDecayRate).toBe(0.05);
    expect(m.relatedCharacterBonus).toBe(0.3);
    expect(m.relatedLocationBonus).toBe(0.2);
    expect(m.accessStrengthBonus).toBe(0.5);
    expect(m.deleteDecayFactor).toBe(0.1);
    expect(m.deleteAfterDays).toBe(7);
    expect(m.fadeDecayFactor).toBe(0.3);
    expect(m.fadeAfterDays).toBe(3);
    expect(m.faintStrengthThreshold).toBe(3);
    expect(m.faintAfterDays).toBe(5);
    expect(m.consolidateImportance).toBe(6);
    expect(m.consolidateAccessCount).toBe(3);
    // 被洞见引用的旧记忆，衰减因子乘这个系数
    // （原代码写死在 simulation-engine.ts 里，阶段 2.5 补漏时外置的）
    expect(m.referencedDecayFactor).toBe(0.3);
  });

  it("感知阈值与长动作门限", () => {
    expect(DEFAULT_RULES.perception.visibleValenceThreshold).toBe(2);
    expect(DEFAULT_RULES.perception.visibleArousalThreshold).toBe(7);
    expect(DEFAULT_RULES.action.longActionMinutes).toBe(60);
  });

  it("六个规则组齐全", () => {
    expect(RULE_GROUPS).toEqual([
      "emotion",
      "needs",
      "memory",
      "perception",
      "action",
    ]);
  });

  it("规则参数总数是 37（加参数时要改这里）", () => {
    // 这个数字的作用不是「卡住」规则层不许长，
    // 是**逼着改它的人想清楚**：加一个参数意味着多一个可调的旋钮，
    // 意味着 world.json 里多一个可能的键。得是有意的。
    let count = 0;
    for (const group of RULE_GROUPS) {
      count += Object.keys(DEFAULT_RULES[group]).length;
    }
    expect(count).toBe(37);
  });
});

// ─── 行为等价性 ──────────────────────────────────────────────────────────

describe("情绪 —— 默认规则下与改造前逐点一致", () => {
  const cases = [
    { current: { valence: 0, arousal: 0 }, event: { valence: 3, intensity: 5 } },
    { current: { valence: 2, arousal: 5 }, event: { valence: -1, intensity: 2 } },
    { current: { valence: -3, arousal: 8 }, event: { valence: 3, intensity: 8 } },
    { current: { valence: 5, arousal: 10 }, event: { valence: -5, intensity: 1 } },
    { current: { valence: -5, arousal: 0 }, event: { valence: 0, intensity: 0 } },
    { current: { valence: 1.5, arousal: 2.5 }, event: { valence: 0.5, intensity: 1.5 } },
  ];

  it.each(cases)("updateEmotion 一致：$current + $event", (c) => {
    const expected = legacyUpdateEmotion(c.current, c.event);
    const actual = updateEmotion(c.current, c.event);
    expect(actual.valence).toBeCloseTo(expected.valence, 12);
    expect(actual.arousal).toBeCloseTo(expected.arousal, 12);
  });

  it.each(cases)("decayEmotion 一致：$current", (c) => {
    const expected = legacyDecayEmotion(c.current);
    const actual = decayEmotion(c.current);
    expect(actual.valence).toBeCloseTo(expected.valence, 12);
    expect(actual.arousal).toBeCloseTo(expected.arousal, 12);
  });

  it("情绪文案全网格一致", () => {
    // 穷举 valence × arousal 的整数网格 —— 文案分档的边界最容易抽错
    for (let valence = -6; valence <= 6; valence++) {
      for (let arousal = 0; arousal <= 11; arousal++) {
        expect(getEmotionLabel(valence, arousal)).toBe(
          legacyGetEmotionLabel(valence, arousal),
        );
      }
    }
  });

  it("文案分档边界点正确", () => {
    expect(getEmotionLabel(2, 6)).toBe("兴奋");
    expect(getEmotionLabel(-2, 6)).toBe("愤怒");
    expect(getEmotionLabel(0, 6)).toBe("紧张");
    expect(getEmotionLabel(2, 3)).toBe("满足");
    expect(getEmotionLabel(0, 3)).toBe("平静");
    expect(getEmotionLabel(2, 2)).toBe("安宁");
    expect(getEmotionLabel(0, 1)).toBe("无聊");
  });
});

describe("需求 —— 默认规则下与改造前逐点一致", () => {
  const actions = [null, "rest", "explore", "work", "exercise", "build", "repair", "idle"];
  const levels = [0, 0.25, 0.5, 0.7, 1];

  it.each(actions)("动作 %s 各直觉水平一致", (action) => {
    for (const level of levels) {
      const state = makeState({ curiosity: 50, currentAction: action });
      const profile = makeProfile({ intuitionLevel: level });
      const expected = legacyDecayNeeds(state, profile);
      const actual = decayNeeds(state, profile, 1);
      expect(actual.curiosity).toBeCloseTo(expected.curiosity!, 12);
    }
  });

  it("体力活动总衰减是空闲的两倍（0.5 → 1.0）", () => {
    const idle = decayNeeds(
      makeState({ curiosity: 50, currentAction: "rest" }),
      makeProfile({ intuitionLevel: 0 }),
      1,
    );
    const strenuous = decayNeeds(
      makeState({ curiosity: 50, currentAction: "explore" }),
      makeProfile({ intuitionLevel: 0 }),
      1,
    );
    expect(idle.curiosity).toBeCloseTo(49.5, 12);
    expect(strenuous.curiosity).toBeCloseTo(49, 12);
  });
});

// ─── 规则合并 ────────────────────────────────────────────────────────────

describe("mergeRules —— 部分规则与默认值合并", () => {
  it("没给任何规则时返回完整默认值", () => {
    const merged = mergeRules(undefined);
    expect(merged).toEqual(DEFAULT_RULES);
  });

  it("只写要改的项，其余保持默认", () => {
    const merged = mergeRules({ emotion: { decayRate: 0.9 } });
    expect(merged.emotion.decayRate).toBe(0.9);
    expect(merged.emotion.valenceCurrentWeight).toBe(0.7);
    expect(merged.emotion.strongArousalThreshold).toBe(6);
    expect(merged.needs.baseDecay).toBe(0.5);
    expect(merged.memory.recencyDecayRate).toBe(0.05);
  });

  it("拼错的键名被忽略，不会变成有效规则", () => {
    const merged = mergeRules({ emotion: { decayRatee: 0.9 } });
    expect(merged.emotion.decayRate).toBe(0.95);
    expect("decayRatee" in merged.emotion).toBe(false);
  });

  it("非数值被忽略", () => {
    const merged = mergeRules({ emotion: { decayRate: "很快" } });
    expect(merged.emotion.decayRate).toBe(0.95);
  });

  it("NaN / Infinity 被忽略", () => {
    const merged = mergeRules({
      emotion: { decayRate: NaN },
      needs: { baseDecay: Infinity },
    });
    expect(merged.emotion.decayRate).toBe(0.95);
    expect(merged.needs.baseDecay).toBe(0.5);
  });

  it("不修改传入的对象", () => {
    const raw = { emotion: { decayRate: 0.9 } };
    mergeRules(raw);
    expect(raw.emotion.decayRate).toBe(0.9);
  });

  it("不合法的输入（null / 数组 / 字符串）返回默认值", () => {
    expect(mergeRules(null)).toEqual(DEFAULT_RULES);
    expect(mergeRules([])).toEqual(DEFAULT_RULES);
    expect(mergeRules("nope")).toEqual(DEFAULT_RULES);
  });

  it("以自定义 base 为基准合并（角色级 override 的用法）", () => {
    const base = mergeRules({ emotion: { decayRate: 0.9 } });
    const merged = mergeRules({ emotion: { decayRate: 0.8 } }, base);
    expect(merged.emotion.decayRate).toBe(0.8);
  });
});

describe("cloneRules —— 深拷贝", () => {
  it("改副本不影响原对象", () => {
    const copy = cloneRules(DEFAULT_RULES);
    copy.emotion.decayRate = 0.1;
    expect(DEFAULT_RULES.emotion.decayRate).toBe(0.95);
  });

  it("嵌套组不共享引用", () => {
    const copy = cloneRules(DEFAULT_RULES);
    expect(copy.memory).not.toBe(DEFAULT_RULES.memory);
    expect(copy.needs).not.toBe(DEFAULT_RULES.needs);
  });
});

describe("validateRules —— 报告问题但不抛错", () => {
  it("默认规则没问题", () => {
    expect(validateRules(DEFAULT_RULES)).toEqual([]);
  });

  // 注意：这些用例**直接构造坏规则对象**，不走 mergeRules ——
  // 因为 mergeRules 现在会把越界的值夹回区间，坏值到不了这里。
  // 「用户到底填了什么」由 validateRawRules 负责（见 rules-range.test.ts）。

  it("权重越界会被报出来", () => {
    const bad = {
      ...DEFAULT_RULES,
      emotion: { ...DEFAULT_RULES.emotion, valenceCurrentWeight: 5 },
    };
    const issues = validateRules(bad);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.join("\n")).toContain("valenceCurrentWeight");
  });

  it("衰减率越界会被报出来", () => {
    const bad = {
      ...DEFAULT_RULES,
      emotion: { ...DEFAULT_RULES.emotion, decayRate: 1.5 },
    };
    expect(validateRules(bad).join("\n")).toContain("decayRate");
  });

  it("范围反了会被报出来", () => {
    const bad = {
      ...DEFAULT_RULES,
      emotion: { ...DEFAULT_RULES.emotion, valenceMin: 5, valenceMax: -5 },
    };
    expect(validateRules(bad).join("\n")).toContain("valenceMin");
  });

  it("一次报出所有问题", () => {
    const bad = {
      ...DEFAULT_RULES,
      emotion: {
        ...DEFAULT_RULES.emotion,
        decayRate: 5,
        valenceCurrentWeight: -1,
      },
      needs: { ...DEFAULT_RULES.needs, baseDecay: -1 },
    };
    const issues = validateRules(bad);
    expect(issues.length).toBeGreaterThanOrEqual(3);
  });
});

// ─── 规则真的能改变行为 ──────────────────────────────────────────────────

describe("规则改了，行为跟着变（这是「可控」的判据）", () => {
  it("情绪衰减率调低 → 情绪消得更快", () => {
    const fast = mergeRules({ emotion: { decayRate: 0.5 } }).emotion;
    const slow = mergeRules({ emotion: { decayRate: 0.99 } }).emotion;
    const start = { valence: 4, arousal: 8 };
    expect(Math.abs(decayEmotion(start, fast).valence)).toBeLessThan(
      Math.abs(decayEmotion(start, slow).valence),
    );
  });

  it("效价事件权重调高 → 情绪更外露", () => {
    const reactive = mergeRules({
      emotion: { valenceCurrentWeight: 0.2, valenceEventWeight: 0.8 },
    }).emotion;
    const sticky = mergeRules({
      emotion: { valenceCurrentWeight: 0.9, valenceEventWeight: 0.1 },
    }).emotion;
    const start = { valence: 0, arousal: 5 };
    const event = { valence: 4, intensity: 5 };
    expect(Math.abs(updateEmotion(start, event, reactive).valence)).toBeGreaterThan(
      Math.abs(updateEmotion(start, event, sticky).valence),
    );
  });

  it("需求基础衰减调高 → 好奇心掉得更快", () => {
    const fast = mergeRules({ needs: { baseDecay: 2 } }).needs;
    const slow = mergeRules({ needs: { baseDecay: 0.1 } }).needs;
    const state = makeState({ curiosity: 50, currentAction: "rest" });
    const profile = makeProfile({ intuitionLevel: 0 });
    expect(decayNeeds(state, profile, 1, fast).curiosity!).toBeLessThan(
      decayNeeds(state, profile, 1, slow).curiosity!,
    );
  });

  it("文案门限调高 → 角色更不动声色", () => {
    const reserved = mergeRules({
      emotion: { strongValenceThreshold: 4, strongArousalThreshold: 9 },
    });
    // 效价 3 —— 原来算「满足」，调高门限后算「平静」
    expect(getEmotionLabel(3, 4)).toBe("满足");
    expect(getEmotionLabel(3, 4, reserved.emotion)).toBe("平静");
  });
});
