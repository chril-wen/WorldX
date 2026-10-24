import { describe, it, expect } from "vitest";
import {
  buildCharacterNameMap,
  buildLocationNameMap,
  formatActionName,
  formatEventType,
  formatEventSummary,
} from "./event-format";

describe("event-format", () => {
  describe("buildCharacterNameMap", () => {
    it("建立 id → name 映射", () => {
      const m = buildCharacterNameMap([
        { id: "char_1", name: "沈四娘" } as any,
        { id: "char_2", name: "陆醒木" } as any,
      ]);
      expect(m).toEqual({ char_1: "沈四娘", char_2: "陆醒木" });
    });

    it("空数组得到空对象", () => {
      expect(buildCharacterNameMap([])).toEqual({});
    });
  });

  describe("buildLocationNameMap", () => {
    it("建立 id → name 映射", () => {
      const m = buildLocationNameMap([
        { id: "main_area", name: "主区域" } as any,
      ]);
      expect(m.main_area).toBe("主区域");
    });
  });

  describe("formatEventType", () => {
    it("已知类型有映射", () => {
      expect(formatEventType("dialogue")).toBeTruthy();
      expect(formatEventType("movement")).toBeTruthy();
    });

    it("未知类型被美化（去掉下划线并首字母大写）", () => {
      expect(formatEventType("some_unknown_type")).toBe("Some Unknown Type");
    });

    it("空字符串返回空", () => {
      expect(formatEventType("")).toBe("");
    });
  });

  describe("formatActionName", () => {
    it("已知动作有映射", () => {
      expect(formatActionName("sleep")).toBeTruthy();
    });

    it("未知动作被美化", () => {
      expect(formatActionName("some_unknown_action")).toBe("Some Unknown Action");
    });

    it("undefined 回落到默认动作", () => {
      expect(formatActionName(undefined)).toBeTruthy();
    });

    it("空字符串也回落到默认动作", () => {
      expect(formatActionName("")).toBeTruthy();
    });
  });

  describe("formatEventSummary", () => {
    const names = { char_1: "沈四娘", char_2: "陆醒木" };
    const locations = { main_area: "茶馆" };

    it("movement 事件带出角色名与目的地", () => {
      const s = formatEventSummary(
        {
          type: "movement",
          actorId: "char_1",
          location: "main_area",
          data: { to: "alley" },
        } as any,
        { characterNames: names, locationNames: { alley: "巷口" } },
      );
      expect(s).toContain("沈四娘");
      expect(s).toContain("巷口");
    });

    it("action_start 事件带出角色名与地点", () => {
      const s = formatEventSummary(
        {
          type: "action_start",
          actorId: "char_1",
          location: "main_area",
          data: { actionName: "sleep" },
        } as any,
        { characterNames: names, locationNames: locations },
      );
      expect(s).toContain("沈四娘");
      expect(s).toContain("茶馆");
    });

    it("dialogue 完整事件带出双方与轮次", () => {
      const s = formatEventSummary(
        {
          type: "dialogue",
          actorId: "char_1",
          targetId: "char_2",
          location: "main_area",
          data: { phase: "complete", turns: [{ content: "你好" }] },
        } as any,
        { characterNames: names },
      );
      expect(s).toContain("沈四娘");
      expect(s).toContain("陆醒木");
    });

    it("dialogue turn 事件带出首句预览", () => {
      const s = formatEventSummary(
        {
          type: "dialogue",
          actorId: "char_1",
          targetId: "char_2",
          location: "main_area",
          data: { phase: "turn", turns: [{ content: "一壶热茶？" }] },
        } as any,
        { characterNames: names },
      );
      expect(s).toContain("一壶热茶");
    });

    it("event_triggered 优先用 title", () => {
      const s = formatEventSummary(
        {
          type: "event_triggered",
          location: "global",
          data: { title: "暴雨将至" },
        } as any,
      );
      expect(s).toBe("暴雨将至");
    });

    it("event_triggered 无 title 时回落 summary", () => {
      const s = formatEventSummary(
        { type: "event_triggered", location: "global", data: { summary: "起风了" } } as any,
      );
      expect(s).toBe("起风了");
    });

    it("world_state_change 的天气变化带图标", () => {
      const s = formatEventSummary(
        {
          type: "world_state_change",
          location: "global",
          data: { kind: "weather", description: "雨停了" },
        } as any,
      );
      expect(s).toContain("🌤️");
      expect(s).toContain("雨停了");
    });

    it("emotion_shift 带出数值", () => {
      const s = formatEventSummary(
        {
          type: "emotion_shift",
          actorId: "char_1",
          location: "main_area",
          data: { urgentNeed: "curiosity", value: 7.4 },
        } as any,
        { characterNames: names },
      );
      expect(s).toContain("沈四娘");
      expect(s).toContain("7");
    });

    it("未知角色 id 被美化成可读名", () => {
      const s = formatEventSummary(
        { type: "reflection", actorId: "char_999", location: "main_area", data: {} } as any,
      );
      expect(s).toContain("999");
    });

    it("无 actorId 时不崩", () => {
      const s = formatEventSummary(
        { type: "reflection", location: "main_area", data: {} } as any,
      );
      expect(typeof s).toBe("string");
    });

    it("空 data 的未知事件类型返回摘要占位", () => {
      const s = formatEventSummary(
        { type: "some_new_type", location: "main_area", data: {} } as any,
      );
      expect(typeof s).toBe("string");
      expect(s.length).toBeGreaterThan(0);
    });

    it("data 为 null 时不崩", () => {
      const s = formatEventSummary(
        { type: "some_new_type", location: "main_area", data: null } as any,
      );
      expect(typeof s).toBe("string");
    });
  });
});
