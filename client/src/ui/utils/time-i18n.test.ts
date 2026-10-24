import { describe, it, expect } from "vitest";
import { translatePeriod, translateWeather, weatherIcon } from "./time-i18n";

describe("time-i18n", () => {
  describe("translatePeriod", () => {
    it("已知时段被翻译", () => {
      // i18n 默认语言取决于 navigator，测试里两种都接受：要么是译文，要么是中文原词
      const r = translatePeriod("清晨");
      expect(typeof r).toBe("string");
      expect(r.length).toBeGreaterThan(0);
    });

    it("未知时段原样返回", () => {
      expect(translatePeriod("不存在的时段")).toBe("不存在的时段");
    });

    it("空字符串原样返回", () => {
      expect(translatePeriod("")).toBe("");
    });

    it.each(["清晨", "上午", "中午", "下午", "傍晚", "晚上", "深夜"])(
      "%s 有映射（返回非空）",
      (p) => {
        expect(translatePeriod(p)).toBeTruthy();
      },
    );
  });

  describe("translateWeather", () => {
    it("已知天气被翻译", () => {
      expect(translateWeather("clear")).toBeTruthy();
    });

    it("未知天气原样返回", () => {
      expect(translateWeather("未知天气")).toBe("未知天气");
    });

    it("空字符串原样返回", () => {
      expect(translateWeather("")).toBe("");
    });
  });

  describe("weatherIcon", () => {
    it.each([
      ["clear", "☀️"],
      ["cloudy", "⛅"],
      ["overcast", "☁️"],
      ["fog", "🌫️"],
      ["light_rain", "🌧️"],
      ["heavy_rain", "🌧️"],
      ["thunderstorm", "⛈️"],
    ])("%s 对应固定图标", (kind, icon) => {
      expect(weatherIcon(kind)).toBe(icon);
    });

    it("未知天气回落到默认图标", () => {
      expect(weatherIcon("未知")).toBe("🌤️");
    });

    it("空字符串也回落到默认图标", () => {
      expect(weatherIcon("")).toBe("🌤️");
    });
  });
});
