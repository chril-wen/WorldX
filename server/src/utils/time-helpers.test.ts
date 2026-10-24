import { describe, it, expect, afterEach } from "vitest";
import {
  absoluteTick,
  compareGameTime,
  gameTimeToString,
  getSceneHour,
  getSceneTickLimit,
  getSceneConfig,
  getNaturalDayTicks,
  getTimePeriodLabel,
  isBoundedScene,
  relativeTimeLabel,
  setSceneConfig,
  tickToSceneTime,
  tickToSceneTimeWithPeriod,
  type SceneTimeConfig,
} from "./time-helpers";

const ORIGINAL = getSceneConfig();

afterEach(() => {
  setSceneConfig(ORIGINAL);
});

function cfg(overrides: Partial<SceneTimeConfig> = {}): SceneTimeConfig {
  return {
    ...ORIGINAL,
    ...overrides,
    multiDay: { ...ORIGINAL.multiDay, ...(overrides.multiDay ?? {}) },
  };
}

describe("time-helpers", () => {
  describe("absoluteTick", () => {
    it("第 1 天第 0 tick 的绝对 tick 是 0", () => {
      expect(absoluteTick({ day: 1, tick: 0 })).toBe(0);
    });

    it("跨天累加", () => {
      setSceneConfig(cfg({ tickDurationMinutes: 15 })); // 一天 96 tick
      expect(absoluteTick({ day: 2, tick: 0 })).toBe(96);
      expect(absoluteTick({ day: 1, tick: 10 })).toBe(10);
    });

    it("同一天内单调递增", () => {
      const a = absoluteTick({ day: 1, tick: 5 });
      const b = absoluteTick({ day: 1, tick: 6 });
      expect(b).toBeGreaterThan(a);
    });
  });

  describe("compareGameTime", () => {
    it("按天优先比较", () => {
      expect(compareGameTime({ day: 1, tick: 99 }, { day: 2, tick: 0 })).toBeLessThan(0);
    });

    it("同一天按 tick 比较", () => {
      expect(compareGameTime({ day: 1, tick: 1 }, { day: 1, tick: 2 })).toBeLessThan(0);
    });

    it("相同时返回 0", () => {
      expect(compareGameTime({ day: 3, tick: 7 }, { day: 3, tick: 7 })).toBe(0);
    });

    it("与 absoluteTick 顺序一致", () => {
      const pairs: [any, any][] = [
        [{ day: 1, tick: 5 }, { day: 2, tick: 0 }],
        [{ day: 2, tick: 3 }, { day: 2, tick: 8 }],
        [{ day: 1, tick: 0 }, { day: 1, tick: 0 }],
      ];
      for (const [a, b] of pairs) {
        const byCompare = compareGameTime(a, b);
        const byAbs = absoluteTick(a) - absoluteTick(b);
        expect(Math.sign(byCompare)).toBe(Math.sign(byAbs));
      }
    });
  });

  describe("tickToSceneTime", () => {
    it("现代格式补零", () => {
      setSceneConfig(cfg({ startTime: "08:00", tickDurationMinutes: 15, displayFormat: "modern" }));
      expect(tickToSceneTime(0)).toBe("08:00");
      expect(tickToSceneTime(1)).toBe("08:15");
      expect(tickToSceneTime(4)).toBe("09:00");
    });

    it("跨过午夜回绕到 24 小时制", () => {
      setSceneConfig(cfg({ startTime: "23:00", tickDurationMinutes: 30, displayFormat: "modern" }));
      expect(tickToSceneTime(0)).toBe("23:00");
      expect(tickToSceneTime(2)).toBe("00:00");
      expect(tickToSceneTime(4)).toBe("01:00");
    });

    it("自定义配置生效", () => {
      setSceneConfig(cfg({ startTime: "06:30", tickDurationMinutes: 10, displayFormat: "modern" }));
      expect(tickToSceneTime(0)).toBe("06:30");
      expect(tickToSceneTime(3)).toBe("07:00");
    });
  });

  describe("tickToSceneTimeWithPeriod", () => {
    it("格式是 时间（时段）", () => {
      setSceneConfig(cfg({ startTime: "08:00", tickDurationMinutes: 15, displayFormat: "modern" }));
      const r = tickToSceneTimeWithPeriod(0);
      expect(r).toMatch(/^08:00（.+）$/);
    });

    it("时段与 getTimePeriodLabel 一致", () => {
      setSceneConfig(cfg({ startTime: "08:00", tickDurationMinutes: 15, displayFormat: "modern" }));
      for (const tick of [0, 10, 30, 60]) {
        const r = tickToSceneTimeWithPeriod(tick);
        expect(r).toContain(`（${getTimePeriodLabel(tick)}）`);
      }
    });
  });

  describe("getSceneHour", () => {
    it("返回 0-23 的整数", () => {
      setSceneConfig(cfg({ startTime: "08:00", tickDurationMinutes: 15 }));
      expect(getSceneHour(0)).toBe(8);
      expect(getSceneHour(4)).toBe(9);
    });

    it("跨午夜回绕", () => {
      setSceneConfig(cfg({ startTime: "22:00", tickDurationMinutes: 60 }));
      expect(getSceneHour(0)).toBe(22);
      expect(getSceneHour(3)).toBe(1);
    });

    it("始终在 0-23 范围内", () => {
      setSceneConfig(cfg({ startTime: "00:00", tickDurationMinutes: 1 }));
      for (let t = 0; t < 100; t++) {
        const h = getSceneHour(t);
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThanOrEqual(23);
      }
    });
  });

  describe("getTimePeriodLabel", () => {
    // 边界是 hours >= 5 && hours < 9 这种半开区间，所以 8 点仍算清晨，9 点才算上午
    it.each([
      [5, "清晨"],
      [8, "清晨"],
      [9, "上午"],
      [11, "上午"],
      [12, "中午"],
      [13, "中午"],
      [14, "下午"],
      [16, "下午"],
      [17, "傍晚"],
      [18, "傍晚"],
      [19, "晚上"],
      [21, "晚上"],
      [22, "深夜"],
      [23, "深夜"],
    ])("小时 %i → %s", (hour, label) => {
      // 起点设为该小时整点，每 tick 1 小时
      setSceneConfig(cfg({ startTime: `${String(hour).padStart(2, "0")}:00`, tickDurationMinutes: 60 }));
      expect(getTimePeriodLabel(0)).toBe(label);
    });

    it("时段永远落在七个已知值里", () => {
      const known = ["清晨", "上午", "中午", "下午", "傍晚", "晚上", "深夜"];
      setSceneConfig(cfg({ startTime: "00:00", tickDurationMinutes: 30 }));
      for (let t = 0; t < 48; t++) {
        expect(known).toContain(getTimePeriodLabel(t));
      }
    });
  });

  describe("isBoundedScene / getSceneTickLimit", () => {
    it("open 场景是有界的", () => {
      expect(isBoundedScene(cfg({ sceneType: "open" }))).toBe(true);
    });

    it("closed 场景不是有界的", () => {
      expect(isBoundedScene(cfg({ sceneType: "closed" }))).toBe(false);
    });

    it("open 场景用 maxTicks 作为上限", () => {
      expect(getSceneTickLimit(cfg({ sceneType: "open", maxTicks: 30 }))).toBe(30);
    });

    it("open 场景没给 maxTicks 时用自然日 tick 数", () => {
      const c = cfg({ sceneType: "open", maxTicks: null, tickDurationMinutes: 15 });
      expect(getSceneTickLimit(c)).toBe(getNaturalDayTicks(c));
    });

    it("closed 场景用自然日 tick 数", () => {
      const c = cfg({ sceneType: "closed", tickDurationMinutes: 30 });
      expect(getSceneTickLimit(c)).toBe(48);
    });

    it("自然日 tick 数随 tick 时长变化", () => {
      expect(getNaturalDayTicks(cfg({ tickDurationMinutes: 15 }))).toBe(96);
      expect(getNaturalDayTicks(cfg({ tickDurationMinutes: 60 }))).toBe(24);
      expect(getNaturalDayTicks(cfg({ tickDurationMinutes: 1440 }))).toBe(1);
    });

    // 已知 BUG（阶段 0 不改业务逻辑，用 it.fails 锁住）：
    // getNaturalDayTicks 是 Math.max(1, Math.round((24*60) / tickDurationMinutes))，
    // tickDurationMinutes = 0 时除出 Infinity，Math.max(1, Infinity) 还是 Infinity ——
    // 「至少为 1」的兜底对 0 无效。tick 上限变成 Infinity 会让按上限循环的逻辑跑不完。
    it.fails("tick 时长为 0 时应回落到 1（已知 bug：算出 Infinity）", () => {
      expect(getNaturalDayTicks(cfg({ tickDurationMinutes: 0 }))).toBe(1);
    });
  });

  describe("gameTimeToString", () => {
    it("格式是 Day N HH:MM", () => {
      setSceneConfig(cfg({ startTime: "08:00", tickDurationMinutes: 15, displayFormat: "modern" }));
      expect(gameTimeToString({ day: 2, tick: 1 })).toBe("Day 2 08:15");
    });
  });

  describe("relativeTimeLabel", () => {
    it("同一天相差 2 tick 内 = 刚才", () => {
      expect(relativeTimeLabel(1, 10, { day: 1, tick: 12 })).toBe("刚才");
    });

    it("同一天相差 3-6 tick = 不久前", () => {
      expect(relativeTimeLabel(1, 10, { day: 1, tick: 14 })).toBe("不久前");
      expect(relativeTimeLabel(1, 10, { day: 1, tick: 16 })).toBe("不久前");
    });

    it("同一天相差超过 6 tick = 今天早些时候", () => {
      expect(relativeTimeLabel(1, 10, { day: 1, tick: 20 })).toBe("今天早些时候");
    });

    it("昨天", () => {
      expect(relativeTimeLabel(1, 10, { day: 2, tick: 5 })).toBe("昨天");
    });

    it("更早 = N 天前", () => {
      expect(relativeTimeLabel(1, 10, { day: 4, tick: 5 })).toBe("3天前");
    });
  });
});
