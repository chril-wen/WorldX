/**
 * 天气实现已迁到 @worldx/core —— 这里保留 server 侧的门面。
 *
 * 原来的 API 是模块级函数（`getWeatherState()` 等），到处都在用；
 * core 里的 `WeatherManager` 是类，存储从构造函数注入。
 * 这个门面用默认的 SQLite 存储把这些模块级函数包起来，既有调用点不用改。
 */

import {
  WeatherManager,
  getWeatherInfoFor,
  getWeatherLabel,
  isWeatherKind,
  resolveExposure,
  isBlockedByWeather,
  describeWeatherFor,
  buildWeatherChangeEvent,
  SEVERE_WEATHER,
  WEATHER_KINDS,
} from "@worldx/core";
import type { WeatherKind, WeatherState, Exposure } from "@worldx/core";
import { sqliteWorldStateStorage } from "../store/storage-adapter.js";

export {
  getWeatherLabel,
  isWeatherKind,
  resolveExposure,
  isBlockedByWeather,
  describeWeatherFor,
  buildWeatherChangeEvent,
  SEVERE_WEATHER,
  WEATHER_KINDS,
};
export type { WeatherKind, WeatherState, Exposure };

let manager = new WeatherManager(sqliteWorldStateStorage);

export function getWeatherManager(): WeatherManager {
  return manager;
}

export function getWeatherState(): WeatherState {
  return manager.getWeatherState();
}

export function getWeatherInfo(): { kind: WeatherKind; label: string } {
  return manager.getWeatherInfo();
}

export function setWeather(kind: WeatherKind, gameTime: { day: number; tick: number }): void {
  manager.setWeather(kind, gameTime);
}

export function advanceWeather(
  gameTime: { day: number; tick: number },
  tickDurationMinutes: number,
  rand: () => number = Math.random,
) {
  return manager.advanceWeather(gameTime, tickDurationMinutes, rand);
}

export { getWeatherInfoFor };
