/**
 * 时间线显示层的测试 —— **不跑进程**，直接调渲染函数。
 *
 * ## 为什么这组要单开一个文件
 *
 * `timeline` 之前是转发给 `scripts/timeline.mjs` 的，而那个脚本自己
 * `console.log` —— 于是 CLI 里 `timeline` 的输出跟其它命令**两套风格**：
 *
 * ```
 * World: world_2026-10-20T11-06-51  (E:\...\output\worlds\world_...)
 * tl-20261020-191801  day 1 tick 21  21 帧
 * ```
 *
 * 对比 `own-world worlds`：
 *
 * ```
 * 生成的世界
 * ───────
 *   world_2026-10-20T11-06-51  水巷口老茶馆
 * ```
 *
 * 这些都是「不报错、但输出难看」的静默问题 ——
 * 只能靠**断言输出内容**来发现。
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  formatGameTime,
  renderDiff,
  renderForked,
  renderSnapshotList,
  renderTimelineList,
} from "../src/lib/timeline-render.mjs";

/**
 * 抓 console.log 的输出。
 *
 * 渲染函数直接 `console.log` —— 测它就抓 stdout。
 */
function captureLog(fn) {
  const lines = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
    lines.push(args.join(" "));
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return lines.join("\n");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("formatGameTime", () => {
  it("写成「第 N 天 M 帧」", () => {
    expect(formatGameTime({ day: 3, tick: 7 }, 21)).toBe("第 3 天 21 帧");
  });

  it("没有帧数就显示 tick", () => {
    expect(formatGameTime({ day: 1, tick: 5 })).toBe("第 1 天 5 帧");
  });
});

describe("renderTimelineList —— 跟 CLI 其它命令一个风格", () => {
  const timelines = [
    {
      id: "tl-20261020-191801",
      label: "另一种可能",
      lastGameTime: { day: 1, tick: 21 },
      tickCount: 21,
      forkedFrom: { timelineId: "tl-base", day: 1, tick: 20 },
    },
  ];

  it("用中文标题 + 分隔线", () => {
    const out = captureLog(() => renderTimelineList({ timelines }));
    expect(out).toContain("时间线（1）");
    expect(out).toContain("─");
  });

  it("不打印绝对路径", () => {
    // 之前脚本开头是 `World: xxx  (E:\...\output\worlds\...)` ——
    // 绝对路径对读的人没用，还把输出撑得很长。
    const out = captureLog(() => renderTimelineList({ timelines }));
    expect(out).not.toContain("E:\\");
    expect(out).not.toContain("output/worlds");
  });

  it("显示标签、时间和分叉来源", () => {
    const out = captureLog(() => renderTimelineList({ timelines }));
    expect(out).toContain("另一种可能");
    expect(out).toContain("第 1 天 21 帧");
    expect(out).toContain("tl-base");
  });

  it("没有时间线时给一句话", () => {
    const out = captureLog(() => renderTimelineList({ timelines: [] }));
    expect(out).toContain("没有时间线");
  });
});

describe("renderSnapshotList", () => {
  it("列出快照的描述和时间", () => {
    const out = captureLog(() =>
      renderSnapshotList({
        snapshots: [
          { id: "snap1", gameDay: 1, gameTick: 21, description: "分岔点", createdAt: "2026-10-26" },
        ],
      }),
    );
    expect(out).toContain("快照（1）");
    expect(out).toContain("分岔点");
    expect(out).toContain("第 1 天");
  });
});

describe("renderDiff —— 字段名中文、小数截断、带差值", () => {
  /** 名字映射（普通对象 —— 渲染模块吃 JSON 过来的数据）。 */
  const names = {
    characterNames: { char_1: "沈四娘" },
    locationNames: { main_area: "主区域" },
    actionNames: { share_table_chat: "拼桌闲谈" },
    pointNames: { main_area_point_1: "主区域点位1" },
  };

  /** core 的 actionLabel（翻内部 action id）。 */
  const actionLabel = (id) =>
    id === "post_dialogue" ? "闲聊余温" : "";

  const comparison = {
    timelineA: { id: "tl-a", lastGameTime: { day: 1, tick: 21 }, tickCount: 21 },
    timelineB: { id: "tl-b", lastGameTime: { day: 1, tick: 22 }, tickCount: 22 },
    eventCounts: { a: 69, b: 72 },
    characters: [
      {
        characterId: "char_1",
        onlyIn: null,
        fields: [
          { field: "currentAction", a: null, b: "post_dialogue" },
          { field: "emotionValence", a: 0.4985865672605756, b: 0.4736572388975468 },
          { field: "emotionArousal", a: 3.4200366853156505, b: 3.399034851049868 },
          { field: "curiosity", a: 76, b: 75 },
        ],
      },
    ],
    memories: [],
  };

  it("字段名是中文", () => {
    const out = captureLog(() => renderDiff({ comparison, names, actionLabel }));
    expect(out).toContain("当前动作");
    expect(out).toContain("情绪效价");
    expect(out).toContain("情绪唤醒");
    expect(out).toContain("好奇");
    // 英文的原始字段名不该出现
    expect(out).not.toContain("emotionValence");
    expect(out).not.toContain("currentAction");
  });

  it("小数截断到 3 位", () => {
    const out = captureLog(() => renderDiff({ comparison, names, actionLabel }));
    expect(out).toContain("0.499");
    expect(out).toContain("0.474");
    expect(out).not.toContain("0.4985865672605756");
  });

  it("带上差值 —— 这才是 diff 的意义", () => {
    const out = captureLog(() => renderDiff({ comparison, names, actionLabel }));
    // 0.4736572388975468 - 0.4985865672605756 ≈ -0.025
    expect(out).toContain("差 -0.025");
    expect(out).toContain("差 -1");
  });

  it("内部 action id 翻成人话", () => {
    const out = captureLog(() => renderDiff({ comparison, names, actionLabel }));
    expect(out).toContain("闲聊余温");
    expect(out).not.toContain("post_dialogue");
  });

  it("角色显示名字而不是 id", () => {
    const out = captureLog(() => renderDiff({ comparison, names, actionLabel }));
    expect(out).toContain("沈四娘");
    expect(out).not.toContain("char_1");
  });

  it("规格表外的字段也显示 —— 漏掉比难看更糟", () => {
    const out = captureLog(() =>
      renderDiff({
        comparison: {
          ...comparison,
          characters: [
            {
              characterId: "char_1",
              onlyIn: null,
              fields: [{ field: "someNewField", a: "x", b: "y" }],
            },
          ],
        },
        names,
        actionLabel,
      }),
    );
    expect(out).toContain("someNewField");
  });

  it("记忆差异显示具体内容，不只是数量", () => {
    const out = captureLog(() =>
      renderDiff({
        comparison: {
          ...comparison,
          memories: [
            {
              characterId: "char_1",
              common: 12,
              onlyInA: 0,
              onlyInB: 1,
              diverged: 0,
              onlyInAMemories: [],
              onlyInBMemories: [{ content: "雨大走不脱", gameDay: 1, gameTick: 22 }],
            },
          ],
        },
        names,
        actionLabel,
      }),
    );
    expect(out).toContain("雨大走不脱");
  });
});

describe("renderForked", () => {
  it("显示新时间线和切换方法", () => {
    const out = captureLog(() =>
      renderForked({ newId: "tl-fork-x", sourceId: "tl-a", snapshotId: "snap1" }),
    );
    expect(out).toContain("tl-fork-x");
    expect(out).toContain("snap1");
    expect(out).toContain("/api/timelines/tl-fork-x/load");
  });
});
