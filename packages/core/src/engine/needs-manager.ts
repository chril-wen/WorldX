import type { CharacterState, CharacterProfile } from "../contracts/index.js";
import { DEFAULT_RULES } from "./rules.js";
import type { NeedsRules } from "./rules.js";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

const STRENUOUS_ACTIONS = ["explore", "work", "exercise", "build", "repair"];

/**
 * 好奇心衰减。
 *
 * 衰减量 = 基础衰减 + 直觉系数 × 直觉水平
 * 体力活动时额外加一档。
 *
 * @param charState 角色当前状态（不修改）
 * @param profile 角色人设
 * @param _tick 当前 tick（保留参数，规则改动可能用得上）
 * @param rules 需求规则 —— 缺省用默认值
 */
export function decayNeeds(
  charState: CharacterState,
  profile: CharacterProfile,
  _tick: number,
  rules: NeedsRules = DEFAULT_RULES.needs,
): Partial<CharacterState> {
  const isStrenuous = STRENUOUS_ACTIONS.some(
    (a) => charState.currentAction?.includes(a),
  );

  const intuitionTerm = rules.intuitionCoefficient * profile.intuitionLevel;
  const curiosityDelta = isStrenuous
    ? -(rules.baseDecay + rules.strenuousExtraDecay + intuitionTerm)
    : -(rules.baseDecay + intuitionTerm);

  return {
    curiosity: clamp(charState.curiosity + curiosityDelta, 0, 100),
  };
}
