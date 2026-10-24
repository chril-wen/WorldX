/**
 * 调用记账的 server 侧实现 —— 成本按 token 算，记录落进 SQLite。
 *
 * core 的 `LLMClient` 只认 `CostTracker` 契约；
 * 定价目前在本文件里，阶段 2 会挪进 `config/models.json`。
 */

import type { CostTracker, LLMCallLog } from "@worldx/core";
import { getDb } from "../store/db.js";
import { generateId } from "../utils/id-generator.js";

const DEFAULT_INPUT_PRICE_PER_1K = 0.001;
const DEFAULT_OUTPUT_PRICE_PER_1K = 0.002;

let tokenPricing: { input: number; output: number } = {
  input: DEFAULT_INPUT_PRICE_PER_1K,
  output: DEFAULT_OUTPUT_PRICE_PER_1K,
};

export function setTokenPricing(input: number, output: number): void {
  tokenPricing = { input, output };
}

export function calculateCost(
  promptTokens: number,
  completionTokens: number,
): number {
  return (
    (promptTokens / 1000) * tokenPricing.input +
    (completionTokens / 1000) * tokenPricing.output
  );
}

export function logCall(log: LLMCallLog): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO llm_call_logs (id, task_type, character_id, model, prompt_tokens, completion_tokens, cost, duration_ms, success, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(
    log.id || generateId(),
    log.taskType,
    log.characterId ?? null,
    log.model,
    log.promptTokens,
    log.completionTokens,
    log.cost,
    log.durationMs,
    log.success,
    log.error ?? null,
  );
}

/** 给 core 的 LLMClient 用的 tracker。 */
export const sqliteCostTracker: CostTracker = {
  calculateCost,
  logCall,
};
