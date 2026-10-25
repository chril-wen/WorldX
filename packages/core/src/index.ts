/**
 * `@worldx/core` —— 模拟引擎的框架无关核心。
 *
 * 这里的代码不依赖 Express / SQLite / Phaser，只依赖标准库与 zod/nanoid。
 * server 通过 npm workspace 消费本包，server 侧保留 re-export 保持既有 import 路径可用。
 */

export * from "./contracts/index.js";

export { updateEmotion, decayEmotion, getEmotionLabel } from "./engine/emotion-manager.js";
export { decayNeeds } from "./engine/needs-manager.js";
export { MemoryManager } from "./engine/memory-manager.js";
export { WorldManager } from "./engine/world-manager.js";
export type { TickAdvanceResult, MainAreaZone } from "./engine/world-manager.js";
export { CharacterManager } from "./engine/character-manager.js";

export {
  DEFAULT_RULES,
  RULE_GROUPS,
  cloneRules,
  mergeRules,
  validateRules,
} from "./engine/rules.js";
export type {
  WorldRules,
  RuleGroup,
  EmotionRules,
  NeedsRules,
  MemoryRules,
  PerceptionRules,
  ActionRules,
} from "./engine/rules.js";

export { PromptBuilder } from "./llm/prompt-builder.js";
export { LLMClient } from "./llm/llm-client.js";
export * from "./llm/output-schemas.js";
export * from "./llm/structured-output.js";

export { SimulationEngine } from "./simulation/simulation-engine.js";
export { DecisionMaker } from "./simulation/decision-maker.js";
export { DialogueGenerator } from "./simulation/dialogue-generator.js";
export { buildPerception } from "./simulation/perceiver.js";
export { buildActionMenu } from "./simulation/action-menu-builder.js";
export { executeAction, completeAction } from "./simulation/action-executor.js";

export { calculateDramScore, flagHighDramaEvents } from "./content/drama-scorer.js";
export { extractQuotes } from "./content/quote-extractor.js";
export { generateDailySummary, generateCharacterWeekly } from "./content/summary-generator.js";
export { generateId } from "./utils/id-generator.js";
export * from "./engine/time-helpers.js";
export {
  WeatherManager,
  WEATHER_KINDS,
  SEVERE_WEATHER,
  isWeatherKind,
  getWeatherLabel,
  getWeatherInfoFor,
  buildWeatherChangeEvent,
  describeWeatherFor,
  resolveExposure,
  isBlockedByWeather,
} from "./engine/weather-manager.js";
export type { WeatherState, Exposure } from "./engine/weather-manager.js";
