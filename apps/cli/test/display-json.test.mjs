/**
 * `display` 段的测试 —— JSON 输出里的人话部分。
 *
 * ## 为什么要有 `display`
 *
 * `own-world tick --json` 给的是**原始事件**：
 *
 * ```json
 * { "actorId": "char_1792860348082", "location": "main_area" }
 * ```
 *
 * 脚本要「林哲」「主区域」得自己去读 `config/world.json` 查映射。
 *
 * 改成替换原始字段是坏主意（脚本可能存库，显示层一改存的数据就变），
 * 所以**加字段不替换**。
 *
 * ## 为什么每条 summary 带 eventId
 *
 * `renderEvents` 会跳过被整段对话取代的单轮事件 ——
 * summaries 的数量**少于** events 的数量。
 * 带 eventId 才能让脚本可靠关联两者。
 */

import { describe, it, expect } from "vitest";
import { buildDisplaySection } from "../src/lib/display-json.mjs";
import { toDisplaySummaries } from "../src/lib/event-render.mjs";

/** 名字映射。 */
const names = {
  characterNames: new Map([
    ["char_1", "赵龙"],
    ["char_2", "林哲"],
  ]),
  locationNames: new Map([["main_area", "主区域"]]),
  actionNames: new Map([["stroll_and_observe", "闲逛观察"]]),
  pointNames: new Map([["main_area_point_1", "主区域点位1"]]),
};

describe("buildDisplaySection", () => {
  const events = [
    { id: "e1", type: "action_start", actorId: "char_1", location: "main_area", data: {} },
  ];
  const rendered = [{ event: events[0], summary: "赵龙 在主区域 找人攀谈" }];

  it("给的是完整映射表，不只是当次用到的", () => {
    // 脚本可能要处理**别的**事件 —— 只给当次的没用。
    const display = buildDisplaySection({ events, rendered, names });
    expect(display.characterNames["char_2"]).toBe("林哲");
    expect(display.locationNames["main_area"]).toBe("主区域");
    expect(display.actionNames["stroll_and_observe"]).toBe("闲逛观察");
    expect(display.pointNames["main_area_point_1"]).toBe("主区域点位1");
  });

  it("summaries 带 eventId", () => {
    const display = buildDisplaySection({ events, rendered, names });
    expect(display.summaries).toHaveLength(1);
    expect(display.summaries[0].eventId).toBe("e1");
    expect(display.summaries[0].summary).toContain("赵龙");
  });

  it("映射表是普通对象 —— Map 序列化会变成 {}", () => {
    // Map 走 JSON 会丢（`JSON.stringify(new Map())` === "{}"）——
    // display 段是要给 `--json` 用的。
    const display = buildDisplaySection({ events, rendered, names });
    expect(JSON.parse(JSON.stringify(display)).characterNames["char_1"]).toBe("赵龙");
  });
});

describe("toDisplaySummaries", () => {
  it("每条摘要绑着自己的事件 id", () => {
    const rendered = [
      { event: { id: "a" }, summary: "第一条" },
      { event: { id: "b" }, summary: "第二条" },
    ];
    expect(toDisplaySummaries(rendered)).toEqual([
      { eventId: "a", summary: "第一条" },
      { eventId: "b", summary: "第二条" },
    ]);
  });

  it("数量可以少于事件数 —— 被整段对话取代的单轮被跳过了", () => {
    // 这正是「带 eventId」的理由：数组长度不一一对应，
    // 靠 index 关联会错位。
    const rendered = [{ event: { id: "complete-1" }, summary: "整段对话" }];
    const out = toDisplaySummaries(rendered);
    expect(out).toHaveLength(1);
    expect(out[0].eventId).toBe("complete-1");
  });
});
