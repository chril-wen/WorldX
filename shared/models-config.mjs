/**
 * 模型配置 —— 从仓库根的 `config/models.json` 读，`.env` 覆盖。
 *
 * 为什么要这个文件：以前四个角色（orchestrator / image / vision / simulation）
 * 各读各的 `process.env.XXX_BASE_URL`，换模型要改四处。
 * 现在默认值集中在一处，`.env` 只管密钥和临时覆盖。
 *
 * **优先级**：`models.json` < 环境变量 < 显式传参
 *
 * 为什么密钥不在 `models.json` 里：那个文件要进版本库。
 * API Key 只在 `.env`（已 gitignore）。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** 仓库根 —— `shared/` 就在根下面，所以往上一级 */
export const REPO_ROOT = path.resolve(__dirname, "..");

export const MODELS_CONFIG_PATH = path.join(REPO_ROOT, "config", "models.json");

// 类型定义在同目录的 `models-config.d.mts` —— 这个文件是纯 .mjs，
// 不能有 TS 语法（`export type` 会让 node 直接报 SyntaxError）。

let cached = null;

/** 读 `config/models.json`。文件不存在时返回空对象 —— 让调用方退回 `.env`。 */
export function loadModelsConfig() {
  if (cached) return cached;
  if (!fs.existsSync(MODELS_CONFIG_PATH)) {
    console.warn(
      `[models-config] 找不到 ${MODELS_CONFIG_PATH} —— 模型配置将全部退回环境变量。`,
    );
    cached = {};
    return cached;
  }
  const raw = fs.readFileSync(MODELS_CONFIG_PATH, "utf-8");
  cached = JSON.parse(raw);
  return cached;
}

/** 丢掉缓存 —— 热加载配置时用。 */
export function reloadModelsConfig() {
  cached = null;
}

/**
 * 取某个角色的端点 —— `models.json` 优先，环境变量覆盖。
 *
 * 环境变量名沿用现有的约定，别改 —— 用户的 `.env` 已经写好了。
 */
export function resolveBaseUrl(role, envVar) {
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;
  return loadModelsConfig()[role]?.baseUrl ?? "";
}

/** 取某个角色的模型名 —— `models.json` 优先，环境变量覆盖。 */
export function resolveModelName(role, envVar) {
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;
  return loadModelsConfig()[role]?.model ?? "";
}

/** 取某个角色的绘图 provider —— 只有 image 角色用。 */
export function resolveImageProvider(envVar) {
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;
  return loadModelsConfig().image?.provider ?? "";
}

/** 取定价 —— `models.json` 优先，环境变量覆盖。 */
export function resolvePricing(role) {
  const envInput = Number(process.env[`${role.toUpperCase()}_INPUT_PRICE_PER_1K`]);
  const envOutput = Number(process.env[`${role.toUpperCase()}_OUTPUT_PRICE_PER_1K`]);
  const fromConfig = loadModelsConfig()[role]?.pricing;
  return {
    inputPer1k: Number.isFinite(envInput) && envInput > 0
      ? envInput
      : (fromConfig?.inputPer1k ?? 0),
    outputPer1k: Number.isFinite(envOutput) && envOutput > 0
      ? envOutput
      : (fromConfig?.outputPer1k ?? 0),
  };
}
