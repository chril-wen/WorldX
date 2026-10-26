/**
 * `actionLabel` 的测试。
 *
 * ## 为什么这个函数要单测
 *
 * 它解决的是「内部 action id 露馅」的问题 ——
 * `post_dialogue` 显示成「结束post_dialogue」是**静默**的：
 * 命令成功、输出有内容、只是难看。
 *
 * 而且它有两个容易搞混的参数（`actionId` vs `displayName`）——
 * 传错一个，行为就悄悄变了。
 */

import { describe, it, expect } from "vitest";
import { actionLabel } from "./event-format.js";

describe("actionLabel", () => {
  it("有显示名就用显示名", () => {
    expect(actionLabel("stroll_and_observe", "闲逛观察")).toBe("闲逛观察");
  });

  it("内部 action id 查表翻成人话", () => {
    expect(actionLabel("post_dialogue", null)).toBe("闲聊余温");
    expect(actionLabel("traveling", null)).toBe("赶路");
    expect(actionLabel("idle", null)).toBe("闲待");
    expect(actionLabel("in_conversation", null)).toBe("对话中");
  });

  it("表里没有的 id 走 prettify", () => {
    expect(actionLabel("some_unknown_action", null)).toBe("Some Unknown Action");
  });

  it("都没有时返回空串", () => {
    expect(actionLabel(null, null)).toBe("");
    expect(actionLabel(undefined, undefined)).toBe("");
  });

  it("显示名优先于内部 action 表", () => {
    // 就算 id 在表里，只要有显示名就用显示名 ——
    // 世界动作的名字是配置里写的，比通用表准。
    expect(actionLabel("idle", "发呆中")).toBe("发呆中");
  });
});
