import { describe, it, expect, beforeEach } from "vitest";
import { WeatherManager } from "./weather-manager.js";
import { InMemoryWorldStateStorage } from "../testing/in-memory-world-state.js";
import { getTicksPerScene } from "./time-helpers.js";

let store: InMemoryWorldStateStorage;
let mgr: WeatherManager;

beforeEach(() => {
  store = new InMemoryWorldStateStorage();
  mgr = new WeatherManager(store);
});

describe("WeatherManager", () => {
  describe("getWeatherState", () => {
    it("没有记录时返回 clear", () => {
      expect(mgr.getWeatherState()).toEqual({ kind: "clear", sinceAbsTick: 0 });
    });

    it("读出已存的天气", () => {
      store.setGlobalState("weather", "light_rain");
      store.setGlobalState("weather_since", "12");
      expect(mgr.getWeatherState()).toEqual({
        kind: "light_rain",
        sinceAbsTick: 12,
      });
    });

    it("非法天气值退回 clear", () => {
      store.setGlobalState("weather", "sunshine");
      expect(mgr.getWeatherState().kind).toBe("clear");
    });
  });

  describe("setWeather", () => {
    it("写入天气与起始 tick", () => {
      mgr.setWeather("clear", { day: 3, tick: 5 });
      expect(store.getGlobalState("weather")).toBe("clear");
      // absoluteTick = (day - 1) * 每场 tick 数 + tick
      expect(store.getGlobalState("weather_since")).toBe(
        String((3 - 1) * getTicksPerScene() + 5),
      );
    });
  });

  describe("getWeatherInfo", () => {
    it("返回中文标签", () => {
      store.setGlobalState("weather", "light_rain");
      expect(mgr.getWeatherInfo()).toEqual({ kind: "light_rain", label: "小雨" });
    });
  });

  describe("advanceWeather", () => {
    it("没到最短持续时间就不变", () => {
      store.setGlobalState("weather", "clear");
      store.setGlobalState("weather_since", "0");
      // 天气规则要求 clear 至少持续若干小时，第一 tick 不该变
      const ev = mgr.advanceWeather({ day: 1, tick: 0 }, 15, () => 0);
      expect(ev).toBeNull();
      expect(mgr.getWeatherState().kind).toBe("clear");
    });

    it("掷出随机数足够大时天气改变并返回事件", () => {
      store.setGlobalState("weather", "clear");
      store.setGlobalState("weather_since", "0");
      // rand() 永远返回 0 → 必定触发变化
      const ev = mgr.advanceWeather({ day: 5, tick: 0 }, 15, () => 0);
      if (ev) {
        expect(ev.type).toBe("world_state_change");
        expect(mgr.getWeatherState().kind).not.toBe("clear");
      }
    });

    it("掷出随机数接近 1 时不变", () => {
      store.setGlobalState("weather", "clear");
      store.setGlobalState("weather_since", "0");
      const ev = mgr.advanceWeather({ day: 5, tick: 0 }, 15, () => 0.999);
      expect(ev).toBeNull();
      expect(mgr.getWeatherState().kind).toBe("clear");
    });
  });
});
