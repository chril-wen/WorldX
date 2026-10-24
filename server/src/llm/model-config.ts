/**
 * 模型配置的 server 侧实现 —— 从 `config/models.json` 读，`.env` 覆盖。
 *
 * core 不碰文件系统（那是阶段 1 定下的边界），所以读文件的活儿在 server 侧，
 * 读完了注入给 core 的 `LLMClient`。
 */

import type { LLMConfig } from "@worldx/core";
import { loadModelsConfig } from "../../../shared/models-config.mjs";

/**
 * 建一个 LLMConfig —— `models.json` 给默认值，`.env` 覆盖。
 *
 * 密钥永远只从 `.env` 读 —— `config/models.json` 要进版本库，不能放密钥。
 */
export function buildLLMConfigFromFiles(): LLMConfig {
  const simulation = loadModelsConfig().simulation ?? {};
  return {
    provider: "openai-compatible",
    baseURL:
      process.env.SIMULATION_BASE_URL || simulation.baseUrl || "https://openrouter.ai/api/v1",
    apiKey: process.env.SIMULATION_API_KEY ?? "",
    defaultModel:
      process.env.SIMULATION_MODEL || simulation.model || "google/gemini-2.5-flash-preview",
  };
}
