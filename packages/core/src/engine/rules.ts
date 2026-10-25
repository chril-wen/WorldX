/**
 * 世界规则 —— 把「世界怎么运转」从代码里的常数变成**数据**。
 *
 * ## 为什么有这个文件
 *
 * 核心命题是「AI 原生，世界可控」。而「可控」的技术含义是：
 * 规则必须**能问、能改、能追溯**。
 *
 * 之前这些数字写死在各个 manager 里：
 *
 * ```ts
 * valence: current.valence * 0.7 + event.valence * 0.3
 * valence: current.valence * 0.95
 * -(0.5 + 1.0 * profile.intuitionLevel)
 * importance >= 6 || m.accessCount >= 3
 * ```
 *
 * 想换一套世界气质（「角色更感性」「记忆更短暂」「社会更动荡」），
 * 只能改代码重跑。**那是黑盒，不是可控。**
 *
 * ## 规则从哪来
 *
 * ```
 * world.json 的 rules 段   ← 世界级
 *   ↓ 角色级 override 覆盖同名项
 * 角色的 rules 字段          ← 个体级
 *   ↓
 * 最终规则 = 合并后的 WorldRules
 * ```
 *
 * 合并逻辑在 `mergeRules()`。**世界级先，角色级后** ——
 * 角色级只覆盖它显式写了的项，没写的继承世界级。
 *
 * ## 默认值必须与改造前逐个数值对齐
 *
 * 这是本阶段**最大的风险**：抽错了不会报错，只会**行为悄悄漂移**。
 *
 * 所以默认值全部来自原硬编码，一个数都没改。改任何一个默认值都是
 * **行为变更**，需要显式决定，不能顺手改。
 *
 * 有个坑记在这儿：`arousal: current.arousal * 0.95 + 3 * 0.05` 里，
 * `3 * 0.05` 和 `3 * (1 - 0.95)` **浮点结果不相等**（差 1.1e-16）。
 * 默认值写 `arousalDecayRate: 0.95`，实现时用 `3 * (1 - 0.95)` 算等价形式
 * 会改变末位 —— 所以实现里保留 `arousalBaseline * (1 - rate)` 的写法，
 * 并且回归测试用 `toBeCloseTo` 而不是 `toBe`。
 */

/**
 * 情绪规则。
 *
 * 决定角色「多快平静下来」「多容易被事情影响」。
 */
export interface EmotionRules {
  /**
   * 效价（valence）更新时，**当前效价**的保留权重（0-1）。
   *
   * 默认 0.7 —— 也就是「七分惯性、三分新事」。
   * 调高 = 情绪更黏（不容易被新事冲掉）；调低 = 情绪更外露（一件事就翻脸）。
   */
  valenceCurrentWeight: number;

  /**
   * 效价更新时，**事件**的权重（0-1）。
   *
   * 默认 0.3。理论上应该跟 `valenceCurrentWeight` 互补（和为 1），
   * 但代码不强制 —— 允许两者都小于 1（情绪向中性收敛）
   * 或大于 1（情绪被放大）。
   */
  valenceEventWeight: number;

  /**
   * 唤醒（arousal）更新时，**当前唤醒**的保留权重（0-1）。
   *
   * 默认 **0.8**。
   *
   * 注意跟效价的那一对（0.7 / 0.3）**不一样** —— 原代码里
   * 效价用 0.7/0.3、唤醒用 0.8/0.2，两者是各自独立的。
   * 这里保持分开，不合并成一个「currentWeight」。
   */
  arousalCurrentWeight: number;

  /**
   * 唤醒更新时，**事件强度**的权重（0-1）。
   *
   * 默认 **0.2**。
   */
  arousalEventWeight: number;

  /** 效价（valence）的取值范围 —— 默认 [-5, 5]。 */
  valenceMin: number;
  valenceMax: number;

  /** 唤醒（arousal）的取值范围 —— 默认 [0, 10]。 */
  arousalMin: number;
  arousalMax: number;

  /**
   * 每 tick 情绪衰减后，唤醒度回落到这个基线。
   *
   * 默认 3 —— 意思是「完全平静」时唤醒度是 3，不是 0。
   * 保留一点底噪，角色不会瘫成木头。
   */
  arousalBaseline: number;

  /**
   * 情绪衰减率（每 tick 保留的比例，0-1）。
   *
   * 默认 0.95。**调低 = 情绪消得快 = 更理性冷静；调高 = 情绪更持久 = 更记仇。**
   */
  decayRate: number;

  /**
   * 「强烈情绪」的效价门限（绝对值）。
   *
   * 默认 2。超过这个值才算「情绪外露」。
   */
  strongValenceThreshold: number;

  /**
   * 情绪文案「强烈」档的唤醒门限。
   *
   * 默认 6 —— 唤醒到这个程度才叫「兴奋/愤怒/紧张」。
   *
   * 注意跟 `perception.visibleArousalThreshold`（默认 7）**不是一个东西**：
   * 那个管「别人能不能看得出你在激动」，这个管「文案怎么归类」。
   * 原代码里两个数确实不同（6 和 7），这里保持分开。
   */
  strongArousalThreshold: number;

  /**
   * 「有情绪」和「平静」的分界 —— 唤醒度门限。
   *
   * 默认 3。
   */
  mildArousalThreshold: number;

  /**
   * 「无聊」的唤醒度上限（低于这个值且效价中性 = 无聊）。
   *
   * 默认 1。
   */
  boredArousalThreshold: number;
}

/**
 * 需求规则 —— 目前只覆盖好奇心衰减。
 */
export interface NeedsRules {
  /**
   * 空闲时的基础衰减量。
   *
   * 默认 0.5。
   */
  baseDecay: number;

  /**
   * 体力活动时额外叠加的衰减量。
   *
   * 默认 0.5 —— 体力活动的总基础衰减 = 0.5 + 0.5 = 1.0，
   * 正好是空闲时（0.5）的两倍。
   *
   * 注意不是 1.0：原代码里体力活动写的是 `1 + 1.0 * intuition`，
   * 它的**总**基数是 1.0，不是「基础 0.5 再加 1.0」（那会是 1.5）。
   */
  strenuousExtraDecay: number;

  /**
   * 直觉水平对衰减的放大系数。
   *
   * 默认 1.0。直觉越高，好奇心掉得越快。
   */
  intuitionCoefficient: number;
}

/**
 * 记忆规则 —— 决定角色「记得住什么、忘得多快」。
 */
export interface MemoryRules {
  /** 检索评分里「相关度」的权重 —— 默认 3。 */
  relevanceWeight: number;

  /** 检索评分里「新鲜度」的权重 —— 默认 2。 */
  recencyWeight: number;

  /** 检索评分里「重要度」的权重 —— 默认 2。 */
  importanceWeight: number;

  /** 检索评分里「情感强度」的权重 —— 默认 1。 */
  emotionalIntensityWeight: number;

  /**
   * 新鲜度随时间衰减的系数。
   *
   * 默认 0.05 —— `recency = 1 / (1 + 0.05 * 距今tick数)`。
   * 调大 = 越快忘掉旧事。
   */
  recencyDecayRate: number;

  /**
   * 相关度加分 —— 记忆涉及当前在场的角色。
   *
   * 默认 0.3。
   */
  relatedCharacterBonus: number;

  /**
   * 相关度加分 —— 记忆发生在当前地点。
   *
   * 默认 0.2。
   */
  relatedLocationBonus: number;

  /**
   * 每次访问对「有效强度」的贡献。
   *
   * 默认 0.5。访问次数越多，记忆越不容易被标记为 faded。
   */
  accessStrengthBonus: number;

  /**
   * 删除门限：衰减因子低于这个值且超过这个天数，记忆被删除。
   *
   * 默认 0.1 / 7 天。
   */
  deleteDecayFactor: number;
  deleteAfterDays: number;

  /**
   * 淡化门限：衰减因子低于这个值且超过这个天数，记忆被标记 faded。
   *
   * 默认 0.3 / 3 天。
   */
  fadeDecayFactor: number;
  fadeAfterDays: number;

  /**
   * 有效强度低于这个值且超过这个天数，记忆被标记 faded。
   *
   * 默认 3 / 5 天。
   */
  faintStrengthThreshold: number;
  faintAfterDays: number;

  /**
   * 巩固门限：重要度达到这个值，记忆转为长期记忆。
   *
   * 默认 6。
   */
  consolidateImportance: number;

  /**
   * 巩固门限：访问次数达到这个值，记忆转为长期记忆。
   *
   * 默认 3。
   */
  consolidateAccessCount: number;

  /**
   * 被新洞见引用时，旧记忆的衰减因子乘以这个系数。
   *
   * 洞见是「从旧记忆里提炼出来的新认知」。旧记忆被引用，说明它还有价值，
   * 但同时它也被新洞见**吸收**了 —— 所以它应该衰减得比平时快。
   *
   * 默认 0.3。
   */
  referencedDecayFactor: number;
}

/**
 * 感知规则 —— 决定角色「能不能注意到别人的情绪」。
 */
export interface PerceptionRules {
  /**
   * 判定「这个角色情绪外露」的效价门限（绝对值）。
   *
   * 默认 2。
   */
  visibleValenceThreshold: number;

  /**
   * 判定「这个角色情绪外露」的唤醒门限。
   *
   * 默认 7。
   */
  visibleArousalThreshold: number;
}

/**
 * 动作规则 —— 目前只覆盖长动作的判定。
 */
export interface ActionRules {
  /**
   * 多长的动作算「长动作」（分钟）。
   *
   * 默认 60。超过这个时长，界面上显示成「约 X 小时」而不是「约 X 分钟」。
   */
  longActionMinutes: number;
}

/**
 * 一整套世界规则。
 */
export interface WorldRules {
  emotion: EmotionRules;
  needs: NeedsRules;
  memory: MemoryRules;
  perception: PerceptionRules;
  action: ActionRules;
}

/**
 * 默认规则 —— **每个数值都来自改造前的硬编码，一个都没改。**
 *
 * 改这里的任何一个数都等于**改变世界的行为**，不是重构。
 * 想改行为，去改 world.json 的 `rules` 段。
 */
export const DEFAULT_RULES: WorldRules = {
  emotion: {
    valenceCurrentWeight: 0.7,
    valenceEventWeight: 0.3,
    arousalCurrentWeight: 0.8,
    arousalEventWeight: 0.2,
    valenceMin: -5,
    valenceMax: 5,
    arousalMin: 0,
    arousalMax: 10,
    arousalBaseline: 3,
    decayRate: 0.95,
    strongValenceThreshold: 2,
    strongArousalThreshold: 6,
    mildArousalThreshold: 3,
    boredArousalThreshold: 1,
  },
  needs: {
    baseDecay: 0.5,
    strenuousExtraDecay: 0.5,
    intuitionCoefficient: 1.0,
  },
  memory: {
    relevanceWeight: 3,
    recencyWeight: 2,
    importanceWeight: 2,
    emotionalIntensityWeight: 1,
    recencyDecayRate: 0.05,
    relatedCharacterBonus: 0.3,
    relatedLocationBonus: 0.2,
    accessStrengthBonus: 0.5,
    deleteDecayFactor: 0.1,
    deleteAfterDays: 7,
    fadeDecayFactor: 0.3,
    fadeAfterDays: 3,
    faintStrengthThreshold: 3,
    faintAfterDays: 5,
    consolidateImportance: 6,
    consolidateAccessCount: 3,
    referencedDecayFactor: 0.3,
  },
  perception: {
    visibleValenceThreshold: 2,
    visibleArousalThreshold: 7,
  },
  action: {
    longActionMinutes: 60,
  },
};

/**
 * 规则组名 —— 用于 CLI 的路径寻址（`emotion.decayRate`）和角色级 override。
 */
export type RuleGroup = keyof WorldRules;

/** 规则组名列表（顺序固定，用于 CLI 展示）。 */
export const RULE_GROUPS: RuleGroup[] = [
  "emotion",
  "needs",
  "memory",
  "perception",
  "action",
];

/**
 * 深拷贝一份规则。
 *
 * 用 `structuredClone` —— 规则对象是纯数据，没有函数和循环引用，
 * 浅拷贝会让嵌套组共享引用，改一份影响两份。
 */
export function cloneRules(rules: WorldRules): WorldRules {
  return structuredClone(rules);
}

/**
 * 把用户提供的（可能残缺的）规则对象补全成完整的规则。
 *
 * 规则组的**任意子集**都可以出现在 world.json 里 —— 只写要改的那几项，
 * 其余的走默认值。**没写 = 保持默认**，不是 0。
 *
 * @param raw 用户提供的部分规则（可能来自 world.json 或角色 override）
 * @param base 基准规则（默认 `DEFAULT_RULES`）
 * @returns 补全后的完整规则
 */
export function mergeRules(
  raw: unknown,
  base: WorldRules = DEFAULT_RULES,
): WorldRules {
  const merged = cloneRules(base);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return merged;
  }

  for (const group of RULE_GROUPS) {
    const groupRaw = (raw as Record<string, unknown>)[group];
    if (
      !groupRaw ||
      typeof groupRaw !== "object" ||
      Array.isArray(groupRaw)
    ) {
      continue;
    }
    const target = merged[group] as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(
      groupRaw as Record<string, unknown>,
    )) {
      // 只接受**已存在的键** —— 拼错的键名会被静默忽略，
      // 而不是写进规则里当垃圾数据。
      if (!(key in target)) continue;
      if (typeof value === "number" && Number.isFinite(value)) {
        target[key] = value;
      }
    }
  }

  return merged;
}

/**
 * 校验规则值是否合理。
 *
 * **只报告问题，不抛错** —— 调规则的人应该看到所有问题一次说清，
 * 而不是改一个报一个。
 *
 * @param rules 待校验的完整规则
 * @returns 问题描述数组，空数组表示没问题
 */
export function validateRules(rules: WorldRules): string[] {
  const issues: string[] = [];

  const e = rules.emotion;
  for (const key of [
    "valenceCurrentWeight",
    "valenceEventWeight",
    "arousalCurrentWeight",
    "arousalEventWeight",
  ] as const) {
    if (e[key] < 0 || e[key] > 1) {
      issues.push(`emotion.${key} 必须在 0-1 之间，当前 ${e[key]}`);
    }
  }
  if (e.decayRate < 0 || e.decayRate > 1) {
    issues.push(`emotion.decayRate 必须在 0-1 之间，当前 ${e.decayRate}`);
  }
  if (e.valenceMin >= e.valenceMax) {
    issues.push(
      `emotion.valenceMin (${e.valenceMin}) 必须小于 valenceMax (${e.valenceMax})`,
    );
  }
  if (e.arousalMin >= e.arousalMax) {
    issues.push(
      `emotion.arousalMin (${e.arousalMin}) 必须小于 arousalMax (${e.arousalMax})`,
    );
  }
  if (e.arousalBaseline < e.arousalMin || e.arousalBaseline > e.arousalMax) {
    issues.push(
      `emotion.arousalBaseline (${e.arousalBaseline}) 必须在 ` +
        `[${e.arousalMin}, ${e.arousalMax}] 之内`,
    );
  }

  const n = rules.needs;
  if (n.baseDecay < 0) {
    issues.push(`needs.baseDecay 不能为负，当前 ${n.baseDecay}`);
  }
  if (n.strenuousExtraDecay < 0) {
    issues.push(
      `needs.strenuousExtraDecay 不能为负，当前 ${n.strenuousExtraDecay}`,
    );
  }
  if (n.intuitionCoefficient < 0) {
    issues.push(
      `needs.intuitionCoefficient 不能为负，当前 ${n.intuitionCoefficient}`,
    );
  }

  const m = rules.memory;
  for (const key of [
    "relevanceWeight",
    "recencyWeight",
    "importanceWeight",
    "emotionalIntensityWeight",
  ] as const) {
    if (m[key] < 0) {
      issues.push(`memory.${key} 不能为负，当前 ${m[key]}`);
    }
  }
  if (m.recencyDecayRate < 0) {
    issues.push(`memory.recencyDecayRate 不能为负，当前 ${m.recencyDecayRate}`);
  }
  if (m.deleteDecayFactor < 0 || m.deleteDecayFactor > 1) {
    issues.push(
      `memory.deleteDecayFactor 必须在 0-1 之间，当前 ${m.deleteDecayFactor}`,
    );
  }
  if (m.fadeDecayFactor < 0 || m.fadeDecayFactor > 1) {
    issues.push(
      `memory.fadeDecayFactor 必须在 0-1 之间，当前 ${m.fadeDecayFactor}`,
    );
  }
  if (m.faintStrengthThreshold < 0) {
    issues.push(
      `memory.faintStrengthThreshold 不能为负，当前 ${m.faintStrengthThreshold}`,
    );
  }

  const p = rules.perception;
  if (p.visibleValenceThreshold < 0) {
    issues.push(
      `perception.visibleValenceThreshold 不能为负，当前 ${p.visibleValenceThreshold}`,
    );
  }
  if (p.visibleArousalThreshold < 0) {
    issues.push(
      `perception.visibleArousalThreshold 不能为负，当前 ${p.visibleArousalThreshold}`,
    );
  }

  const a = rules.action;
  if (a.longActionMinutes <= 0) {
    issues.push(
      `action.longActionMinutes 必须大于 0，当前 ${a.longActionMinutes}`,
    );
  }

  return issues;
}
