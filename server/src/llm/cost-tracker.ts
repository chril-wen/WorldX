/**
 * 调用记账的 server 侧实现 —— 成本按 token 算，记录落进 SQLite。
 *
 * core 的 `LLMClient` 只认 `CostTracker` 契约；
 * 定价来自 `config/models.json` 的 `simulation.pricing`，
 * 环境变量 `SIMULATION_INPUT_PRICE_PER_1K` / `SIMULATION_OUTPUT_PRICE_PER_1K` 可覆盖。
 */

import type { CostTracker, LLMCallLog } from "@worldx/core";
import { getDb } from "../store/db.js";
import { generateId } from "../utils/id-generator.js";
import { loadModelsConfig } from "../../../shared/models-config.mjs";

/** 显式设置定价（覆盖配置）。没调用时用 `config/models.json` 里的值。 */
let tokenPricing: { input: number; output: number } | null = null;

export function setTokenPricing(input: number, output: number): void {
  tokenPricing = { input, output };
}

function currentPricing(): { input: number; output: number } {
  if (tokenPricing) return tokenPricing;

  const envInput = Number(process.env.SIMULATION_INPUT_PRICE_PER_1K);
  const envOutput = Number(process.env.SIMULATION_OUTPUT_PRICE_PER_1K);
  const fromConfig = loadModelsConfig().simulation?.pricing;

  return {
    input:
      Number.isFinite(envInput) && envInput > 0
        ? envInput
        : (fromConfig?.inputPer1k ?? 0),
    output:
      Number.isFinite(envOutput) && envOutput > 0
        ? envOutput
        : (fromConfig?.outputPer1k ?? 0),
  };
}

export function calculateCost(
  promptTokens: number,
  completionTokens: number,
): number {
  const pricing = currentPricing();
  return (
    (promptTokens / 1000) * pricing.input +
    (completionTokens / 1000) * pricing.output
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
