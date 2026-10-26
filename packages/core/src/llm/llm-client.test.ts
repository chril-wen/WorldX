import { describe, it, expect, vi } from "vitest";
import { LLMClient } from "./llm-client.js";
import type { CostTracker, LLMCallLog } from "@own-world/core";

/**
 * 守住一个曾经让**所有 LLM 记账失效**的 bug。
 *
 * bug：core 的 `logResult` 里 `logCall` 包在空的 `catch {}` 里。
 * 而 server 侧的 `logCall` 传给 better-sqlite3 的是 `log.success`（boolean），
 * SQLite 不接受 boolean 会抛错 —— 异常被静默吞掉，
 * 结果是**每一次 LLM 调用的账单都没记进去**，却没有任何报错。
 *
 * 那个 `? 1 : 0` 的转换在阶段 1 搬家时丢了（见 774c6f1）。
 *
 * 注意 core 不碰 better-sqlite3（阶段 1 定的边界），
 * 所以这里用假 tracker 模拟「记账抛错」这个场景。
 */
describe("LLM 记账", () => {
  function makeClient(tracker: CostTracker): LLMClient {
    return new LLMClient(
      { provider: "openai-compatible", baseURL: "http://x", apiKey: "k", defaultModel: "m" },
      tracker,
    );
  }

  it("记账失败时必须 warn，不能静默吞掉", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tracker: CostTracker = {
      calculateCost: () => 0.1,
      logCall: () => {
        throw new Error("SQLite3 can only bind numbers, strings, bigints, buffers, and null");
      },
    };

    const client = makeClient(tracker);
    // 直接调私有的 logResult —— 不发网络请求
    (client as any).logResult({ taskType: "test_task" }, "m", 10, 20, 5, true, undefined);

    // 关键断言：以前这里是空 catch，异常被吞掉，什么都不报
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls[0].join(" ")).toContain("test_task");

    warn.mockRestore();
  });

  it("记账成功时记下 success 和成本", () => {
    const logged: LLMCallLog[] = [];
    const tracker: CostTracker = {
      calculateCost: (p, c) => (p / 1000) * 0.001 + (c / 1000) * 0.002,
      logCall: (log) => { logged.push(log); },
    };

    const client = makeClient(tracker);
    (client as any).logResult({ taskType: "ok_task" }, "m", 1000, 500, 5, true, undefined);

    expect(logged).toHaveLength(1);
    expect(logged[0].success).toBe(true);
    expect(logged[0].taskType).toBe("ok_task");
    expect(logged[0].cost).toBeCloseTo(0.001 * 1 + 0.002 * 0.5, 10);
  });

  it("失败时记下 success=false 和错误信息", () => {
    const logged: LLMCallLog[] = [];
    const tracker: CostTracker = {
      calculateCost: () => 0,
      logCall: (log) => { logged.push(log); },
    };

    const client = makeClient(tracker);
    (client as any).logResult({ taskType: "fail_task" }, "m", 0, 0, 5, false, "boom");

    expect(logged[0].success).toBe(false);
    expect(logged[0].error).toBe("boom");
  });
});
