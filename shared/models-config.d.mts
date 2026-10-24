/**
 * `shared/models-config.mjs` 的类型声明。
 *
 * 那个文件是纯 `.mjs`（跟 `shared/structured-output.mjs` 一致），
 * 但 server 的 TypeScript 要用它 —— 所以补一份手写声明。
 */

export type ModelRole = "orchestrator" | "image" | "vision" | "simulation";

export interface ModelPricing {
  inputPer1k: number;
  outputPer1k: number;
}

export interface ModelRoleConfig {
  baseUrl?: string;
  model?: string;
  provider?: string;
  pricing?: ModelPricing;
}

export type ModelsConfig = Partial<Record<ModelRole, ModelRoleConfig>>;

export const REPO_ROOT: string;
export const MODELS_CONFIG_PATH: string;

export function loadModelsConfig(): ModelsConfig;
export function reloadModelsConfig(): void;
export function resolveBaseUrl(role: ModelRole, envVar: string): string;
export function resolveModelName(role: ModelRole, envVar: string): string;
export function resolveImageProvider(envVar: string): string;
export function resolvePricing(role: ModelRole): ModelPricing;
