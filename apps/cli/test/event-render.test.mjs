/**
 * 事件渲染的测试 —— **不跑进程**，直接调函数。
 *
 * ## 为什么这组要单开一个文件
 *
 * 渲染逻辑是纯函数（事件 → 一行人话），测它不需要起子进程。
 * 而且**这些 bug 静默得很**：
 *
 * - 名字表读错世界 → 显示裸 id，但命令「成功」
 * - 整段对话和单轮都渲染 → 同一句话出现两遍
 * - 内部 action 没翻 → 显示「结束post_dialogue」
 *
 * 都是「不报错、但输出难看」的问题 —— 只能靠断言输出内容来发现。
 */

import { describe, it, expect } from "vitest";
import { renderEvent, renderEvents } from "../src/lib/event-render.mjs";

/** 角色名表。 */
const names = new Map([
  ["char_1", "赵龙"],
  ["char_2", "林哲"],
  ["char_3", "宋福"],
]);

/** 地点名表。 */
const locations = new Map([
  ["main_area", "主区域"],
  ["pawnshop_interior", "恒顺当铺内堂"],
]);

/**
 * 造一个 dialogue 事件。
 *
 * @param {object} opts
 */
function dialogue({ phase, convId = "conv1", turns, actorId = "char_1", targetId = "char_2" }) {
  return {
    id: `e_${phase}_${turns.length}`,
    gameDay: 1,
    gameTick: 1,
    type: "dialogue",
    actorId,
    targetId,
    location: "main_area",
    data: { conversationId: convId, phase, turns },
  };
}

describe("renderEvent —— 角色和地点用名字", () => {
  it("角色显示名字而不是 id", async () => {
    const line = await renderEvent(
      {
        id: "e1",
        gameDay: 1,
        gameTick: 1,
        type: "action_start",
        actorId: "char_3",
        location: "main_area",
        data: { actionType: "world_action", interactionName: "找人攀谈" },
      },
      names,
      locations,
    );
    expect(line).toContain("宋福");
    expect(line).toContain("主区域");
    expect(line).not.toContain("char_3");
  });

  it("内部 action 翻成人话，不露裸 id", async () => {
    const line = await renderEvent(
      {
        id: "e2",
        gameDay: 1,
        gameTick: 1,
        type: "action_end",
        actorId: "char_1",
        location: "main_area",
        data: { action: "post_dialogue", targetId: null },
      },
      names,
      locations,
    );
    expect(line).toContain("闲聊余温");
    expect(line).not.toContain("post_dialogue");
  });

  it("世界动作用自己的中文名，不被内部 action 表覆盖", async () => {
    const line = await renderEvent(
      {
        id: "e3",
        gameDay: 1,
        gameTick: 1,
        type: "action_end",
        actorId: "char_1",
        location: "main_area",
        data: { action: "stroll_and_observe", actionName: "闲逛观察", targetId: null },
      },
      names,
      locations,
    );
    expect(line).toContain("闲逛观察");
  });
});

describe("renderEvents —— 整段对话不重复", () => {
  it("有 complete 事件时，跳过同一段对话的单轮事件", async () => {
    const events = [
      dialogue({ phase: "turn", turns: [{ speaker: "char_1", content: "站住。" }] }),
      dialogue({
        phase: "turn",
        turns: [{ speaker: "char_2", content: "来者何人？" }],
      }),
      dialogue({
        phase: "complete",
        turns: [
          { speaker: "char_1", content: "站住。" },
          { speaker: "char_2", content: "来者何人？" },
        ],
      }),
    ];

    const rendered = await renderEvents(events, names, locations);

    // 整段对话替掉了两条单轮 —— 只剩一条
    expect(rendered).toHaveLength(1);
    const summary = rendered[0].summary;
    expect(summary).toContain("站住。");
    expect(summary).toContain("来者何人？");
  });

  it("对话还没结束（没有 complete）时，单轮照常显示", async () => {
    const events = [
      dialogue({ phase: "turn", turns: [{ speaker: "char_1", content: "站住。" }] }),
    ];
    const rendered = await renderEvents(events, names, locations);
    expect(rendered).toHaveLength(1);
    expect(rendered[0].summary).toContain("站住。");
  });

  it("摘要和事件绑在一起 —— 调用方不会错位", async () => {
    const events = [
      dialogue({ phase: "turn", turns: [{ speaker: "char_1", content: "第一句" }] }),
      dialogue({
        phase: "complete",
        turns: [
          { speaker: "char_1", content: "第一句" },
          { speaker: "char_2", content: "第二句" },
        ],
      }),
      {
        id: "e_action",
        gameDay: 1,
        gameTick: 2,
        type: "action_end",
        actorId: "char_3",
        location: "main_area",
        data: { action: "idle", targetId: null },
      },
    ];

    const rendered = await renderEvents(events, names, locations);

    // 长度一致，且每一项的 event 和 summary 对得上
    expect(rendered).toHaveLength(2);
    expect(rendered[0].event.type).toBe("dialogue");
    expect(rendered[0].summary).toContain("第一句");
    // 第二项是 action_end，不是第一句对话 —— 不错位
    expect(rendered[1].event.type).toBe("action_end");
    expect(rendered[1].summary).toContain("宋福");
  });
});
