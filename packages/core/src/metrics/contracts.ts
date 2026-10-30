/**
 * 指标层的输入契约 —— 「一次跑完的模拟」长什么样。
 *
 * ## 为什么要有这一层
 *
 * 观测能力的瓶颈不是「跑模拟」，是「**看结果**」。
 * 阶段 2.5 把 A/B 方法论验证过了（确定性假 LLM、A/A 对照、方向性断言），
 * 但那是**一次性脚本** —— 度量维度写死在 `scripts/rules-ab.mjs` 的 `runOnce()` 里，
 * 改一个指标就得改脚本。而 `scripts/rules-real-compare.mjs` 又自己写了一套
 * 摘要抽取，**两份实现已经开始漂移**。
 *
 * 这一层把「变了什么」变成自动可读、可对比、有基线的。
 *
 * ## 关键设计：指标层**不碰 IO**
 *
 * core 只依赖 nanoid + zod —— 指标层不能碰 fs / express / sqlite，
 * 更不能碰 `node:fs`。它必须接收「**已经跑完的模拟结果**」作为输入。
 *
 * 采集这个快照的代码住在运行层（`metrics/runner.ts`），指标层只消费它。
 * 这样指标层能同时被 CLI、server API、将来 UI 的规则面板复用。
 *
 * ## 为什么不用 `Storage` 接口当输入
 *
 * `Storage` 是**读写**接口，而指标层只需要**读**。
 * 直接传 `Storage` 会让指标层有机会写回被观察的对象 ——
 * 而这正是历史上假信号的一个成因（见 `worldx-metrics-layer-design-constraints`）。
 *
 * 传快照 = 传一份**已经定下来的事实**，指标层改不动它。
 */

import type {
  CharacterProfile,
  CharacterState,
  MemoryEntry,
} from "../contracts/index.js";
import type { ContentCandidate, SimulationEvent } from "../contracts/index.js";

/**
 * 一次跑完的模拟的结果快照。
 *
 * **这是指标层唯一的输入。** 采集它需要碰存储，所以采集代码在运行层。
 */
export interface SimulationSnapshot {
  /** 这次模拟产出的全部事件（按时间顺序）。 */
  events: SimulationEvent[];
  /** 全部角色的运行时状态。 */
  characterStates: CharacterState[];
  /** 全部角色的记忆（已按角色分组）。 */
  memories: MemoryEntry[];
  /** 全部角色的人设配置。 */
  profiles: CharacterProfile[];
  /** 高光 / 金句 / 摘要候选。 */
  highlights: ContentCandidate[];
  /**
   * 实际跑到第几天。
   *
   * **跨日是长期记忆类指标的前提** ——
   * 记忆巩固/衰减只在日末触发（`simulation-engine.ts` → `runEndOfDayDecay`）。
   * 跑不到一整天，`isLongTerm` 恒为 false → 长期记忆指标恒为 0 → **假阴性**。
   *
   * 指标层用这个字段判断「某个指标这次可不可用」，
   * 不可用时返回 `null` 而不是报 0。
   */
  finalDay: number;
}

/**
 * 指标的输入依赖 —— 用来判断「这个指标这次可不可用」。
 *
 * 存在的理由跟 `SimulationSnapshot.finalDay` 一样：
 * **报 0 和报「不可用」是两件事**。报 0 会让人以为「长期记忆是 0」，
 * 实际是「这个实验根本没跨日，指标不适用」。
 */
export type MetricRequirement =
  /** 需要跨过至少一个完整日（日末的巩固/衰减才跑过）。 */
  | "crosses-day-boundary"
  /** 需要至少有一条记忆。 */
  | "has-memories"
  /** 需要至少一个 action_start 事件（分母类指标）。 */
  | "has-actions"
  /** 需要至少一个 dialogue 事件。 */
  | "has-dialogue"
  /** 需要至少一个角色状态。 */
  | "has-characters";

/**
 * 指标的方向 —— 用于自动断言。
 *
 * `none` 表示这个指标**没有明确的方向**（比如「记忆条数」本身无好坏）。
 */
export type MetricDirection = "higher" | "lower" | "none";

/**
 * 一个指标。
 *
 * 设计跟 `content/` 的风格一致：**存储接口作参数，不碰具体实现**。
 * 这里更进一步 —— 连存储接口都不要，只要一份快照。
 */
export interface Metric {
  /** 稳定标识，如 `"memory.longTermRate"`。 */
  key: string;
  /** 中文标签，如 `"长期记忆占比"`。 */
  label: string;
  /**
   * 这个指标有没有明确的方向（用于自动断言）。
   *
   * 没有方向的指标**不参与方向性断言** —— 强行给它编一个方向
   * 会让「B 比 A 大」被误读成「B 更好」。
   */
  direction: MetricDirection;
  /**
   * 这个指标需要哪些输入 —— 用来判断「这次可不可用」。
   *
   * **缺一项就返回 `null`**，在报告里显式标「不可用」。
   */
  requires: MetricRequirement[];
  /**
   * 计算。不可用时返回 `null`（**不是 0**）。
   *
   * 必须是**纯函数**：不碰 IO、不读时钟、不用随机数。
   * 同样的快照算两次必须完全一样 —— 否则 A/A 对照会假红。
   */
  compute(snapshot: SimulationSnapshot): number | null;
}
