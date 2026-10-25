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
 * **世界设计可用的**规则键 —— 白名单。
 *
 * ## 为什么有这份白名单
 *
 * 设计流程的提示词（`prompts/world-creation.md`）里要列出可用的规则名。
 * 那份清单以前是**手写**的，跟这里的 `DEFAULT_RULES` 各维护一份。
 *
 * 两份东西必然漂移 —— 而且漂移的方向很隐蔽：
 * 提示词里漏一个键，LLM 就永远用不上那个旋钮；
 * 提示词里多一个键（拼错的），`mergeRules` 会**静默忽略**它，
 * LLM 以为自己改了规则，其实什么都没发生。
 *
 * 所以把「哪些键是给世界设计用的」变成**这里的数据**，
 * 提示词的清单从它生成，测试也从它校验。
 *
 * ## 白名单外的键是什么
 *
 * - `valenceMin` / `valenceMax` / `arousalMin` / `arousalMax` ——
 *   情绪的**取值范围**。这些是引擎的硬边界，不是「世界的气质」，
 *   让 LLM 去调它们只会有两种结果：调出一个不合理的范围，
 *   或者调出一个合理但用户没要求的范围。**不该给 LLM。**
 *
 * - `referencedDecayFactor` —— 洞见引用旧记忆时的衰减系数。
 *   这是引擎内部的**实现细节**（旧记忆被新洞见吸收，所以衰减更快），
 *   对世界设计者来说没有可理解的语义。**不该给 LLM。**
 *
 * 换句话说：白名单 = **「换一套世界气质」时你会想拧的旋钮**。
 * 不是所有规则参数都是气质旋钮。
 */
export const WORLD_DESIGN_RULE_KEYS: Record<RuleGroup, readonly string[]> = {
  emotion: [
    "decayRate",
    "valenceCurrentWeight",
    "valenceEventWeight",
    "arousalCurrentWeight",
    "arousalEventWeight",
    "strongValenceThreshold",
    "strongArousalThreshold",
    "mildArousalThreshold",
    "boredArousalThreshold",
    "arousalBaseline",
  ],
  needs: ["baseDecay", "strenuousExtraDecay", "intuitionCoefficient"],
  memory: [
    "recencyDecayRate",
    "relevanceWeight",
    "recencyWeight",
    "importanceWeight",
    "emotionalIntensityWeight",
    "relatedCharacterBonus",
    "relatedLocationBonus",
    "consolidateImportance",
    "consolidateAccessCount",
    "deleteDecayFactor",
    "deleteAfterDays",
    "fadeDecayFactor",
    "fadeAfterDays",
    "faintStrengthThreshold",
    "faintAfterDays",
    "accessStrengthBonus",
  ],
  perception: ["visibleValenceThreshold", "visibleArousalThreshold"],
  action: ["longActionMinutes"],
};

/**
 * 白名单里的键是不是都真实存在。
 *
 * 写错了就在这里暴露，而不是等到 LLM 用了一个不存在的键、
 * `mergeRules` 静默忽略、用户以为改了规则其实没改。
 */
export function validateWorldDesignRuleKeys(): string[] {
  const issues: string[] = [];
  for (const group of RULE_GROUPS) {
    const actual = Object.keys(DEFAULT_RULES[group]);
    for (const key of WORLD_DESIGN_RULE_KEYS[group]) {
      if (!actual.includes(key)) {
        issues.push(
          `WORLD_DESIGN_RULE_KEYS.${group} 列了不存在的键 "${key}"`,
        );
      }
    }
  }
  return issues;
}

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
        // 夹进合法区间 —— 见 RULE_RANGES 的说明。
        // 越界的值不会报错，只会让世界静默崩坏（实测 decayRate=1.8
        // 六个 tick 后效价从 3 涨到 46875）。这里挡住它。
        const range = RULE_RANGES[`${group}.${key}`];
        target[key] = range
          ? clampRuleValue(value, range)
          : value;
      }
    }
  }

  return merged;
}

/**
 * 每个规则参数的**取值范围**。
 *
 * ## 为什么要有这张表
 *
 * 规则值有三条入口，全部是外部输入：
 *
 * | 入口 | 谁能写 |
 * |---|---|
 * | `world.json` 的 `rules` 段 | 人手写、插件写 |
 * | 角色配置的 `rules` 段 | 人手写、插件写 |
 * | 世界设计流程 | **LLM 直出**（`prompts/world-creation.md` 里的 `rules` 段） |
 *
 * 提示词写了「0-1，默认 0.95」是**建议**，不是**保证** ——
 * LLM 会给出 1.8，插件作者也会写错。
 *
 * 而一个越界的值不会报错，只会**让世界静默崩坏**。实测 `emotion.decayRate = 1.8`：
 * 6 个 tick 后效价从 3 涨到 46875，全程零报错。
 *
 * 抽规则这一阶段最该防的就是这类 bug ——
 * **抽错了不报错，只让行为悄悄漂移**。规则抽出来之后，
 * 「改错了不报错」的风险从代码搬到了数据里。
 * 这张表就是把那条防线补回来：**任何入口写进来的值都会被夹回合理区间**。
 *
 * ## 范围本身也是数据
 *
 * 范围不是散落在 `validateRules()` 的 if 语句里，而是**一张表** ——
 * 这样「哪些参数有范围」和「范围是多少」是同一份事实，
 * 加新参数时不会出现「忘了加校验」这种漂移。
 * `rules.test.ts` 有一条断言锁住「每个参数都必须在表里」。
 *
 * ## 语义
 *
 * - `min`/`max` 是**闭区间**，超出就夹到端点
 * - `min`/`max` 都可以省略（表示那一侧无界）
 * - `step` 留空表示连续值；整数参数用它约束
 */
export interface RuleRange {
  min?: number;
  max?: number;
  /** 是否必须是整数。 */
  integer?: boolean;
}

/**
 * 规则参数的范围表 —— **37 个参数，一个不漏**。
 *
 * 键名格式：`组.参数`。
 */
export const RULE_RANGES: Record<string, RuleRange> = {
  // ─── 情绪 ───
  "emotion.valenceCurrentWeight": { min: 0, max: 1 },
  "emotion.valenceEventWeight": { min: 0, max: 1 },
  "emotion.arousalCurrentWeight": { min: 0, max: 1 },
  "emotion.arousalEventWeight": { min: 0, max: 1 },
  // 取值范围本身是引擎的硬边界，允许调，但要合理
  "emotion.valenceMin": { min: -100, max: 0 },
  "emotion.valenceMax": { min: 0, max: 100 },
  "emotion.arousalMin": { min: 0, max: 50 },
  "emotion.arousalMax": { min: 0, max: 100 },
  "emotion.arousalBaseline": { min: 0, max: 100 },
  "emotion.decayRate": { min: 0, max: 1 },
  "emotion.strongValenceThreshold": { min: 0, max: 100 },
  "emotion.strongArousalThreshold": { min: 0, max: 100 },
  "emotion.mildArousalThreshold": { min: 0, max: 100 },
  "emotion.boredArousalThreshold": { min: 0, max: 100 },

  // ─── 需求 ───
  "needs.baseDecay": { min: 0, max: 100 },
  "needs.strenuousExtraDecay": { min: 0, max: 100 },
  "needs.intuitionCoefficient": { min: 0, max: 100 },

  // ─── 记忆 ───
  "memory.relevanceWeight": { min: 0, max: 100 },
  "memory.recencyWeight": { min: 0, max: 100 },
  "memory.importanceWeight": { min: 0, max: 100 },
  "memory.emotionalIntensityWeight": { min: 0, max: 100 },
  "memory.recencyDecayRate": { min: 0, max: 100 },
  "memory.relatedCharacterBonus": { min: 0, max: 100 },
  "memory.relatedLocationBonus": { min: 0, max: 100 },
  "memory.accessStrengthBonus": { min: 0, max: 100 },
  "memory.deleteDecayFactor": { min: 0, max: 1 },
  "memory.deleteAfterDays": { min: 0, max: 100, integer: true },
  "memory.fadeDecayFactor": { min: 0, max: 1 },
  "memory.fadeAfterDays": { min: 0, max: 100, integer: true },
  "memory.faintStrengthThreshold": { min: 0, max: 100 },
  "memory.faintAfterDays": { min: 0, max: 100, integer: true },
  "memory.consolidateImportance": { min: 0, max: 100 },
  "memory.consolidateAccessCount": { min: 0, max: 100, integer: true },
  "memory.referencedDecayFactor": { min: 0, max: 1 },

  // ─── 感知 ───
  "perception.visibleValenceThreshold": { min: 0, max: 100 },
  "perception.visibleArousalThreshold": { min: 0, max: 100 },

  // ─── 动作 ───
  "action.longActionMinutes": { min: 1, max: 1440, integer: true },
};

/**
 * 把一个值夹进它该有的范围。
 *
 * 越界就夹到端点 —— **不抛错，也不丢弃**。
 *
 * 为什么夹而不是拒绝：规则值可能来自 LLM 或插件作者，
 * 他们没有义务知道每个参数的合法区间。一个 1.8 的衰减率
 * 说明作者想要「比正常更强」—— 夹到 1 已经很接近他的本意，
 * 而直接丢弃会让世界默默退回默认值（「我明明改了规则，怎么没变？」）。
 *
 * 为什么不抛错：世界不该因为一个旋钮拨错就起不来。
 * `validateRules()` 会把问题报给人看，钳制负责保证世界还活着。
 *
 * @param value 原始值
 * @param range 该参数的取值范围
 * @returns 夹进范围后的值
 */
export function clampRuleValue(value: number, range: RuleRange): number {
  let out = value;
  if (range.min !== undefined && out < range.min) out = range.min;
  if (range.max !== undefined && out > range.max) out = range.max;
  if (range.integer) out = Math.round(out);
  return out;
}

/**
 * 校验规则值是否合理。
 *
 * **只报告问题，不抛错** —— 调规则的人应该看到所有问题一次说清，
 * 而不是改一个报一个。
 *
 * ## 注意：校验的是**原始值**，不是钳制后的值
 *
 * `mergeRules()` 会把越界的值夹回区间。所以拿合并后的规则来校验，
 * 永远看不到问题 —— 证据已经被夹掉了。
 *
 * 要看「用户到底填了什么」，用 `validateRawRules()` 校验**未合并**的
 * 原始片段（world.json 里的 `rules` 段、角色配置的 `rules` 段）。
 * CLI 就是这么做的。
 *
 * @param rules 待校验的完整规则
 * @returns 问题描述数组，空数组表示没问题
 */
export function validateRules(rules: WorldRules): string[] {
  const issues: string[] = [];

  // 逐个参数对照范围表 —— 「检查哪些参数」和「范围是多少」
  // 是同一份事实，加新参数时不会漏。
  for (const group of RULE_GROUPS) {
    const groupRules = rules[group] as unknown as Record<string, number>;
    for (const [key, value] of Object.entries(groupRules)) {
      const range = RULE_RANGES[`${group}.${key}`];
      if (!range) continue;
      issues.push(...checkRange(`${group}.${key}`, value, range));
    }
  }

  // 跨参数的一致性 —— 单看范围表看不出来。
  const e = rules.emotion;
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

  return issues;
}

/**
 * 校验**原始规则片段**（未合并）里的值。
 *
 * 这是给「用户填的东西」用的 —— world.json 的 `rules` 段、
 * 角色配置的 `rules` 段、LLM 设计流程产出的 `rules` 段。
 *
 * 片段可以是**部分的**（只写了一两项），所以只检查它写了的那些。
 *
 * 跟 `validateRules()` 的区别：那个查合并后的完整规则，
 * 这个查**原样**填进来的值 —— 越界的证据在这里还在。
 *
 * @param raw 原始规则片段（可能是部分规则，也可能形状不对）
 * @returns 问题描述数组，空数组表示没问题
 */
export function validateRawRules(raw: unknown): string[] {
  const issues: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return issues;
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
    for (const [key, value] of Object.entries(
      groupRaw as Record<string, unknown>,
    )) {
      const range = RULE_RANGES[`${group}.${key}`];
      if (!range) {
        // 键不存在 —— mergeRules 会静默忽略它。
        // 这里报出来，因为「我改了规则却没生效」最常见的原因就是这个。
        const known = Object.keys(DEFAULT_RULES[group]);
        if (!known.includes(key)) {
          issues.push(
            `规则「${group}」里没有「${key}」，会被忽略。可用：` +
              known.join(", "),
          );
        }
        continue;
      }
      if (typeof value !== "number" || !Number.isFinite(value)) {
        issues.push(
          `${group}.${key} 必须是数字，当前 ${JSON.stringify(value)}（会被忽略）`,
        );
        continue;
      }
      issues.push(...checkRange(`${group}.${key}`, value, range));
    }
  }

  return issues;
}

/**
 * 校验单个值是否在范围内。
 *
 * @param path 参数路径（`组.参数`），用于报错信息
 * @param value 原始值
 * @param range 允许的范围
 * @returns 问题描述数组
 */
function checkRange(
  path: string,
  value: number,
  range: RuleRange,
): string[] {
  const issues: string[] = [];
  if (range.min !== undefined && value < range.min) {
    issues.push(`${path} 不能小于 ${range.min}，当前 ${value}`);
  }
  if (range.max !== undefined && value > range.max) {
    issues.push(`${path} 不能大于 ${range.max}，当前 ${value}`);
  }
  if (range.integer && !Number.isInteger(value)) {
    issues.push(`${path} 必须是整数，当前 ${value}`);
  }
  return issues;
}
