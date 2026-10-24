export interface GameTime {
  day: number;
  tick: number;
}

export interface MultiDayConfig {
  enabled: boolean;
  endOfDayText: string;
  newDayText: string;
  nextDayStartTime: string;
}

export interface SceneConfigInfo {
  sceneType: string;
  startTime: string;
  tickDurationMinutes: number;
  maxTicks: number | null;
  displayFormat: string;
  description: string;
  multiDay: MultiDayConfig;
}

export interface SceneRuntimeInfo {
  bounded: boolean;
  cycleTicks: number;
  naturalDayTicks: number;
  transitionEnabled: boolean;
}

export interface CharacterInfo {
  id: string;
  name: string;
  role: string;
  nickname: string;
  location: string;
  mainAreaPointId?: string | null;
  emotion: string;
  currentAction: string | null;
  currentActionLabel?: string | null;
  anchor?: { type: "region" | "element"; targetId: string } | null;
}

export interface CharacterProfile {
  id: string;
  name: string;
  role: string;
  nickname: string;
  backstory?: string;
  appearanceHint?: string;
  coreMotivation: string;
  coreValues: string[];
  speakingStyle: string;
  fears: string[];
  socialStyle: string;
  tags: string[];
  [key: string]: unknown;
}

export interface CharacterDetail {
  profile: CharacterProfile;
  state: {
    location: string;
    mainAreaPointId?: string | null;
    currentAction: string | null;
    currentActionLabel?: string | null;
    emotionValence: number;
    emotionArousal: number;
    curiosity: number;
  };
  emotionLabel: string;
}

export interface DiaryEntry {
  day: number;
  content: string;
  createdAt: string;
}

export interface MemoryEntry {
  type: string;
  content: string;
  importance: number;
  createdAt: string;
}

export interface DialogueTurn {
  speaker: string;
  content: string;
  innerMonologue?: string;
}

export interface DialogueEventData {
  conversationId: string;
  phase: "turn" | "complete";
  turns: DialogueTurn[];
  turnIndexStart: number;
  isFinal: boolean;
  participants: string[];
  memoriesGenerated?: Record<string, string>;
  endReason?: string;
}

export interface SimulationEvent {
  id: string;
  type: string;
  gameDay: number;
  gameTick: number;
  timeString?: string;
  period?: string;
  actorId?: string;
  targetId?: string;
  location?: string;
  data: any | DialogueEventData;
  innerMonologue?: string;
  dramScore?: number;
  createdAt: string;
}

export type WeatherKind =
  | "clear"
  | "cloudy"
  | "overcast"
  | "fog"
  | "light_rain"
  | "heavy_rain"
  | "thunderstorm";

export interface WeatherInfo {
  kind: WeatherKind;
  label: string;
}

export interface WorldTimeInfo extends GameTime {
  timeString: string;
  period: string;
  weather?: WeatherInfo;
}

export interface LocationInfo {
  id: string;
  name: string;
  description: string;
}

export interface MainAreaPointInfo {
  id: string;
  name: string;
  x: number;
  y: number;
  adjacentPointIds: string[];
}

export interface TimelineMeta {
  id: string;
  worldId: string;
  createdAt: string;
  updatedAt: string;
  lastGameTime: GameTime;
  tickCount: number;
  status: "recording" | "stopped";
  /** 分叉来源 —— 这条时间线是从哪条时间线的哪个快照分出来的 */
  forkedFrom?: {
    timelineId: string;
    snapshotId: string;
    tick: number;
    day: number;
  };
  /** 人类可读的标签 */
  label?: string;
}

export interface SnapshotMeta {
  id: string;
  gameDay: number;
  gameTick: number;
  description: string;
  filePath: string;
  createdAt: string;
}

export interface TimelineComparison {
  timelineA: {
    id: string;
    label?: string;
    lastGameTime: GameTime;
    tickCount: number;
  };
  timelineB: {
    id: string;
    label?: string;
    lastGameTime: GameTime;
    tickCount: number;
  };
  characters: {
    characterId: string;
    onlyIn: "a" | "b" | null;
    fields: { field: string; a: unknown; b: unknown }[];
  }[];
  memories: {
    characterId: string;
    onlyInA: number;
    onlyInB: number;
    common: number;
    diverged: number;
  }[];
  eventCounts: { a: number; b: number };
  forkedFrom?: {
    timelineId: string;
    snapshotId: string;
    day: number;
    tick: number;
  };
}

export interface TimelineWithWorld {
  worldId: string;
  worldName: string;
  source?: "user" | "library";
  isCurrent: boolean;
  timelines: TimelineMeta[];
}

export interface TimelineInitFrame {
  type: "init";
  gameTime: GameTime;
  characters: {
    id: string;
    name: string;
    location: string;
    mainAreaPointId: string | null;
  }[];
}

export interface TimelineTickFrame {
  type: "tick";
  gameTime: GameTime;
  events: SimulationEvent[];
}

export type TimelineFrame = TimelineInitFrame | TimelineTickFrame;
