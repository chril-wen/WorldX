import { DEFAULT_RULES } from "./rules.js";
import type { EmotionRules } from "./rules.js";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * 事件驱动的情绪更新。
 *
 * ```
 * valence' = 当前效价 × currentWeight + 事件效价 × eventWeight
 * arousal' = 当前唤醒 × currentWeight + 事件强度 × eventWeight
 * ```
 *
 * @param current 当前情绪
 * @param event 事件带来的情绪冲击
 * @param rules 情绪规则 —— 缺省用默认值
 */
export function updateEmotion(
  current: { valence: number; arousal: number },
  event: { valence: number; intensity: number },
  rules: EmotionRules = DEFAULT_RULES.emotion,
): { valence: number; arousal: number } {
  return {
    valence: clamp(
      current.valence * rules.valenceCurrentWeight +
        event.valence * rules.valenceEventWeight,
      rules.valenceMin,
      rules.valenceMax,
    ),
    arousal: clamp(
      current.arousal * rules.arousalCurrentWeight +
        event.intensity * rules.arousalEventWeight,
      rules.arousalMin,
      rules.arousalMax,
    ),
  };
}

/**
 * 每 tick 的情绪衰减。
 *
 * ```
 * valence' = 当前效价 × decayRate
 * arousal' = 当前唤醒 × decayRate + 基线 × (1 - decayRate)
 * ```
 *
 * **注意最后一项的写法**：原代码是 `+ 3 * 0.05`，
 * 这里写成 `arousalBaseline * (1 - decayRate)` —— 两者**浮点结果不相等**
 * （`3 * 0.05` = 0.15000000000000002，`3 * (1 - 0.95)` = 0.15000000000000013，
 * 差 1.1e-16）。
 *
 * 这么写是为了让 `decayRate` 真的可调 —— 保留 `3 * 0.05` 的话，
 * decayRate 改了基线项却不跟着变，规则就是假的。
 * 末位差异对行为无影响，回归测试用 `toBeCloseTo` 锁。
 *
 * @param current 当前情绪
 * @param rules 情绪规则 —— 缺省用默认值
 */
export function decayEmotion(
  current: {
    valence: number;
    arousal: number;
  },
  rules: EmotionRules = DEFAULT_RULES.emotion,
): { valence: number; arousal: number } {
  return {
    valence: current.valence * rules.decayRate,
    arousal:
      current.arousal * rules.decayRate +
      rules.arousalBaseline * (1 - rules.decayRate),
  };
}

/**
 * 情绪 → 文案。
 *
 * 门限全部来自规则 —— 想让角色「更不动声色」就调高
 * `strongValenceThreshold`。
 *
 * @param valence 效价
 * @param arousal 唤醒
 * @param rules 情绪规则 —— 缺省用默认值
 */
export function getEmotionLabel(
  valence: number,
  arousal: number,
  rules: EmotionRules = DEFAULT_RULES.emotion,
): string {
  if (arousal >= rules.strongArousalThreshold) {
    if (valence >= rules.strongValenceThreshold) return "兴奋";
    if (valence <= -rules.strongValenceThreshold) return "愤怒";
    return "紧张";
  }
  if (arousal >= rules.mildArousalThreshold) {
    if (valence >= rules.strongValenceThreshold) return "满足";
    if (valence <= -rules.strongValenceThreshold) return "沮丧";
    return "平静";
  }
  // arousal < mildArousalThreshold
  if (valence >= rules.strongValenceThreshold) return "安宁";
  if (valence <= -rules.strongValenceThreshold) return "悲伤";
  if (arousal <= rules.boredArousalThreshold) return "无聊";
  return "平静";
}
