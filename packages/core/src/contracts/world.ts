/** 游戏时间 */
export interface GameTime {
  day: number;
  tick: number;
}

/** 场景时间配置 */
export interface MultiDayConfig {
  enabled: boolean;
  endOfDayText: string;
  newDayText: string;
  nextDayStartTime: string;
}

export interface SceneConfig {
  sceneType: "closed" | "open";
  startTime: string;
  tickDurationMinutes: number;
  maxTicks: number | null;
  displayFormat: "modern" | "ancient_chinese" | "fantasy";
  description: string;
  multiDay: MultiDayConfig;
}

export interface WorldSizeConfig {
  width: number;
  height: number;
  tileSize?: number;
  gridWidth?: number;
  gridHeight?: number;
}

/** 区域配置（来自 world.json） */
export interface LocationConfig {
  id: string;
  name: string;
  description: string;
  adjacentLocations: string[];
  objects: ObjectConfig[];
  /** true = sheltered from the weather; false = open air. Unset = unknown. */
  indoor?: boolean;
}

export interface MainAreaPointConfig {
  id: string;
  name: string;
  x: number;
  y: number;
  adjacentPointIds: string[];
}

/** 可交互物件配置 */
export interface ObjectConfig {
  id: string;
  name: string;
  locationId: string;
  defaultState: string;
  capacity: number;
  interactions: InteractionConfig[];
}

/** 交互定义 */
export interface InteractionConfig {
  id: string;
  name: string;
  description?: string;
  availableWhenState: string[];
  duration: number;
  effects: Effect[];
  repeatable?: boolean;
  /** Where the activity happens. Overrides the location's indoor flag for weather checks. */
  exposure?: "indoor" | "outdoor";
  /** Weather kinds that forbid this activity. When unset, outdoor activities are blocked in severe weather. */
  blockedWeather?: WeatherKind[];
  /** When true, this interaction requires dialogue with the anchored character instead of standalone object interaction */
  requiresAnchor?: boolean;
}

export type WeatherKind =
  | "clear"
  | "cloudy"
  | "overcast"
  | "fog"
  | "light_rain"
  | "heavy_rain"
  | "thunderstorm";

/** 世界级动作定义 */
export interface WorldActionConfig extends InteractionConfig {}

/** 交互效果 */
export interface Effect {
  type:
    | "world_state"
    | "character_need"
    | "character_memory"
    | "character_emotion";
  target: string;
  value: any;
}

/** 物件运行时状态（存 DB） */
export interface ObjectRuntimeState {
  objectId: string;
  locationId: string;
  state: string;
  stateDescription: string;
  currentUsers: string[];
}

/** 世界全局状态键值对 */
export interface WorldGlobalEntry {
  key: string;
  value: string;
}

/**
 * 中心区域的默认 id。
 *
 * 中心区域 = 世界的**公共枢纽** —— 角色在里面用
 * `mainAreaPointId` 点位寻址（而不是靠区域 id 定位）。
 *
 * 旧世界没有 `centerLocationId` 字段时用它 —— 行为跟改造前完全一致。
 */
export const DEFAULT_CENTER_LOCATION_ID = "main_area";

/**
 * world.json 的 schema 版本。
 *
 * **缺失时视为 1**（v1 = 没有 `schemaVersion` 字段的世界）。
 * 迁移函数见 `engine/world-migration.ts`。
 */
export const WORLD_SCHEMA_VERSION = 2;

/** 世界配置根结构 */
export interface WorldConfig {
  /**
   * schema 版本 —— 缺失时视为 1。
   *
   * 由 `migrateWorldConfig()` 维护，不要手写。
   */
  schemaVersion?: number;

  /**
   * 中心区域的 id —— 世界的公共枢纽。
   *
   * 缺失时视为 `"main_area"`。
   *
   * 之前这个概念是**写死**的 `"main_area"` 字面量，散落在 79 处代码里。
   * 抽成字段之后，世界可以有自己的中心区域名 ——
   * 而代码只管问「中心区域是哪个」。
   */
  centerLocationId?: string;

  worldName?: string;
  worldDescription?: string;
  worldSocialContext?: string;
  contentLanguage?: "zh" | "en";
  originalPrompt?: string;
  scene?: SceneConfig;
  worldActions?: WorldActionConfig[];
  locations: LocationConfig[];
  mainAreaPoints?: MainAreaPointConfig[];
  worldSize?: WorldSizeConfig;
  economics?: { items: ItemDefinition[] } | null;
  weather?: { preset: string; indoorDefault?: boolean } | null;
  hearsay?: { enabled: boolean } | null;

  /**
   * 世界规则 —— 决定这个世界「怎么运转」。
   *
   * **只写要改的项**，其余走默认值（`DEFAULT_RULES`）。
   * 例：
   * ```json
   * { "rules": { "emotion": { "decayRate": 0.9 } } }
   * ```
   * 情绪消得更快 = 更理性冷静。
   *
   * 类型是 `unknown` —— 形状由 `mergeRules()` 兜底，
   * 写错的键名会被忽略而不是当成有效规则。
   */
  rules?: unknown;
}

export interface ItemDefinition {
  id: string;
  name: string;
  initialStock: number;
  consumptionPerUse?: number;
  restockAction?: string;
  restockAmount?: number;
  displayStates?: Record<string, number>;
  trackedBy?: string;
}
