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

/** 世界配置根结构 */
export interface WorldConfig {
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
