/**
 * 调用记账 —— core 记一次模型调用，成本由外部算。
 *
 * 定价是配置（阶段 2 会挪进 `config/models.json`），写日志是存储的事，
 * 所以这两件事都留给 server 侧实现，core 只在调用结束时通知一声。
 */

import type { LLMCallLog } from "./index.js";

export interface CostTracker {
  /** 按 token 数算这次调用的成本。 */
  calculateCost(promptTokens: number, completionTokens: number): number;
  /** 落一条调用记录。 */
  logCall(log: LLMCallLog): void;
}
