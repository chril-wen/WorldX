/**
 * Weather system: rule + probability driven, no LLM calls.
 * State lives in world global state ("weather", "weather_since") so it is
 * per-timeline, visible in the state inspector, and survives restarts.
 */

import type { GameTime, SimulationEvent } from "../types/index.js";
import type { InteractionConfig, LocationConfig, WeatherKind } from "../types/world.js";
import { generateId } from "../utils/id-generator.js";
import { absoluteTick, getSceneHour } from "../utils/time-helpers.js";
import * as worldState from "../store/world-state-store.js";

export const WEATHER_KINDS: WeatherKind[] = [
  "clear", "cloudy", "overcast", "fog", "light_rain", "heavy_rain", "thunderstorm",
];

/** Outdoor activities are blocked by default under these. */
export const SEVERE_WEATHER: ReadonlySet<WeatherKind> = new Set(["heavy_rain", "thunderstorm"]);

interface WeatherRule {
  /** Hours the weather holds before it may change. */
  minHours: number;
  /** Chance per in-game hour of changing once minHours has passed. */
  changePerHour: number;
  next: Partial<Record<WeatherKind, number>>;
  /** If set, the weather changes much faster outside these hours [from, to). */
  hourWindow?: [number, number];
}

// Fixed generic climate shared by every world.
const RULES: Record<WeatherKind, WeatherRule> = {
  clear:        { minHours: 3, changePerHour: 0.12, next: { cloudy: 6, fog: 1 } },
  cloudy:       { minHours: 2, changePerHour: 0.2,  next: { clear: 4, overcast: 4, light_rain: 1 } },
  overcast:     { minHours: 2, changePerHour: 0.25, next: { cloudy: 3, light_rain: 4, fog: 1 } },
  fog:          { minHours: 1, changePerHour: 0.35, next: { clear: 3, cloudy: 3, overcast: 1 }, hourWindow: [4, 10] },
  light_rain:   { minHours: 1, changePerHour: 0.3,  next: { overcast: 4, cloudy: 2, heavy_rain: 2 } },
  heavy_rain:   { minHours: 1, changePerHour: 0.45, next: { light_rain: 5, thunderstorm: 1 } },
  thunderstorm: { minHours: 1, changePerHour: 0.6,  next: { heavy_rain: 3, light_rain: 2 } },
};

// Fog only forms in the early morning.
const FOG_FORM_HOURS: [number, number] = [4, 9];

const LABELS: Record<WeatherKind, string> = {
  clear: "晴朗",
  cloudy: "多云",
  overcast: "阴天",
  fog: "起雾",
  light_rain: "小雨",
  heavy_rain: "大雨",
  thunderstorm: "雷雨",
};

const OUTDOOR_PHRASES: Record<WeatherKind, string> = {
  clear: "天气晴朗",
  cloudy: "天上多云",
  overcast: "天色阴沉",
  fog: "四下起了雾，远处看不真切",
  light_rain: "下着小雨",
  heavy_rain: "下着大雨，在外面会被淋透",
  thunderstorm: "雷雨交加，在外面很危险",
};

const INDOOR_PHRASES: Partial<Record<WeatherKind, string>> = {
  fog: "窗外起了雾",
  light_rain: "窗外下着小雨",
  heavy_rain: "外面下着大雨，雨声很响",
  thunderstorm: "外面雷雨交加",
};

const CHANGE_PHRASES: Partial<Record<WeatherKind, string>> = {
  clear: "天放晴了",
  cloudy: "云渐渐多了起来",
  overcast: "天色暗了下来",
  fog: "起雾了",
  light_rain: "下起了小雨",
  heavy_rain: "雨下大了",
  thunderstorm: "打雷了，雷雨来了",
};

export type Exposure = "indoor" | "outdoor" | "unknown";

export interface WeatherState {
  kind: WeatherKind;
  sinceAbsTick: number;
}

export function isWeatherKind(value: unknown): value is WeatherKind {
  return typeof value === "string" && (WEATHER_KINDS as string[]).includes(value);
}

export function getWeatherLabel(kind: WeatherKind): string {
  return LABELS[kind];
}

/** Compact weather payload for API responses and the UI. */
export function getWeatherInfo(): { kind: WeatherKind; label: string } {
  const kind = getWeatherState().kind;
  return { kind, label: LABELS[kind] };
}

export function getWeatherState(): WeatherState {
  const raw = worldState.getGlobalState("weather");
  const since = Number(worldState.getGlobalState("weather_since") ?? 0);
  return {
    kind: isWeatherKind(raw) ? raw : "clear",
    sinceAbsTick: Number.isFinite(since) ? since : 0,
  };
}

export function setWeather(kind: WeatherKind, gameTime: GameTime): void {
  worldState.setGlobalState("weather", kind);
  worldState.setGlobalState("weather_since", String(absoluteTick(gameTime)));
}

function inHourWindow(hour: number, [from, to]: [number, number]): boolean {
  return hour >= from && hour < to;
}

function pickNext(rule: WeatherRule, hour: number, rand: () => number): WeatherKind | null {
  const entries = Object.entries(rule.next) as [WeatherKind, number][];
  const weighted = entries.filter(([kind]) => kind !== "fog" || inHourWindow(hour, FOG_FORM_HOURS));
  const total = weighted.reduce((sum, [, w]) => sum + w, 0);
  if (total <= 0) return null;
  let roll = rand() * total;
  for (const [kind, weight] of weighted) {
    roll -= weight;
    if (roll <= 0) return kind;
  }
  return weighted[weighted.length - 1][0];
}

/**
 * Roll the weather for this tick. Returns a world_state_change event when it changes.
 * `rand` is injectable for tests.
 */
export function advanceWeather(
  gameTime: GameTime,
  tickDurationMinutes: number,
  rand: () => number = Math.random,
): SimulationEvent | null {
  const current = getWeatherState();
  const nowAbs = absoluteTick(gameTime);
  const elapsedHours = (Math.max(0, nowAbs - current.sinceAbsTick) * tickDurationMinutes) / 60;
  const rule = RULES[current.kind];
  const hour = getSceneHour(gameTime.tick);

  const outOfWindow = rule.hourWindow && !inHourWindow(hour, rule.hourWindow);
  if (!outOfWindow && elapsedHours < rule.minHours) return null;

  const perHour = outOfWindow ? 0.9 : rule.changePerHour;
  const perTick = 1 - Math.pow(1 - perHour, tickDurationMinutes / 60);
  if (rand() >= perTick) return null;

  const next = pickNext(rule, hour, rand);
  if (!next || next === current.kind) return null;

  setWeather(next, gameTime);
  return buildWeatherChangeEvent(current.kind, next, gameTime, "natural");
}

export function buildWeatherChangeEvent(
  from: WeatherKind,
  to: WeatherKind,
  gameTime: GameTime,
  source: "natural" | "manual",
): SimulationEvent {
  return {
    id: generateId(),
    gameDay: gameTime.day,
    gameTick: gameTime.tick,
    type: "world_state_change",
    location: "global",
    data: {
      kind: "weather",
      from,
      to,
      source,
      description: CHANGE_PHRASES[to] ?? `天气变为${LABELS[to]}`,
    },
    tags: ["weather"],
  };
}

/** One line of weather for a character's perception. */
export function describeWeatherFor(
  state: WeatherState,
  exposure: Exposure,
  gameTime: GameTime,
  tickDurationMinutes: number,
): string {
  const elapsedMin = Math.max(0, absoluteTick(gameTime) - state.sinceAbsTick) * tickDurationMinutes;
  const duration =
    elapsedMin < 30 ? "刚刚" : elapsedMin < 90 ? "已有一阵" : `已持续约${Math.round(elapsedMin / 60)}小时`;
  const base =
    exposure === "indoor"
      ? INDOOR_PHRASES[state.kind] ?? `外面${LABELS[state.kind]}`
      : OUTDOOR_PHRASES[state.kind];
  const where = exposure === "indoor" ? "（你在室内）" : exposure === "outdoor" ? "（你在室外）" : "";
  return `天气：${base}，${duration}${where}`;
}

/** Indoor/outdoor of an activity: the interaction's own tag wins, then the location's. */
export function resolveExposure(
  interaction: Pick<InteractionConfig, "exposure"> | undefined,
  location: Pick<LocationConfig, "indoor"> | undefined,
): Exposure {
  if (interaction?.exposure) return interaction.exposure;
  if (location?.indoor === true) return "indoor";
  if (location?.indoor === false) return "outdoor";
  return "unknown";
}

/**
 * Whether the weather rules out this activity. Explicit blockedWeather wins;
 * otherwise outdoor activities are blocked in severe weather. Untagged activities
 * are never blocked, so worlds without exposure tags behave as before.
 */
export function isBlockedByWeather(
  interaction: Pick<InteractionConfig, "exposure" | "blockedWeather">,
  location: Pick<LocationConfig, "indoor"> | undefined,
  kind: WeatherKind,
): boolean {
  if (Array.isArray(interaction.blockedWeather)) {
    return interaction.blockedWeather.includes(kind);
  }
  return resolveExposure(interaction, location) === "outdoor" && SEVERE_WEATHER.has(kind);
}
