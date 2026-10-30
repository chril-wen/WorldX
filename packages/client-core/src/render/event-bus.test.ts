/**
 * 新事件总线与 Phaser 的 `eventemitter3` **等价性对拍**。
 *
 * ## 为什么这个要测
 *
 * 8.3 要把整个 client 从 `Phaser.Events.EventEmitter` 换到
 * client-core 的 `WorldEventBus`。
 *
 * 换事件总线最大的风险不是「类型对不上」——
 * 那是编译期就能发现的。真正的风险是**行为漂移**：
 *
 * - 同一个回调订阅两次，新实现去重、旧实现不重
 *   → 面板的 `useEffect` 在 StrictMode 下跑两遍，
 *   **事件被处理两次**（比如对话气泡弹两次）。
 * - `off` 只摘一次性的、不摘永久的
 *   → 订阅**泄漏**，每次热重载多一份监听器。
 * - `once` 的触发时机不同（在回调**之后**摘）
 *   → 回调里再 `emit` 同一个事件 → **无限递归**。
 *
 * 这些都不会报错，只会让界面「怪怪的」。
 *
 * ## 怎么测
 *
 * **同一段脚本跑两遍** —— 一遍用 `eventemitter3`（旧），
 * 一遍用新实现 —— 然后**逐条比对可观测行为**。
 *
 * 判据不是「我以为它是这样」，而是「旧实现**实际**是这样」——
 * 基准是 `eventemitter3` 本身，跟 8.1/8.2 的 A/B 同一套规矩。
 *
 * ## 为什么基准用 `eventemitter3` 而不是 `Phaser.Events.EventEmitter`
 *
 * Phaser 的 `EventEmitter` **就是** `eventemitter3` 的子类
 * （`client/node_modules/phaser/src/events/EventEmitter.js`
 * 里 `Extends: EE`），只多了 `shutdown` / `destroy` 两个方法。
 *
 * 直接依赖 `eventemitter3` 更轻 —— 它是 Phaser 的传递依赖，
 * 而且在 node 里能跑（Phaser 本体在 node 里跑不起来）。
 */

import { describe, expect, it } from "vitest";
import EE from "eventemitter3";
import { createWorldEventBus } from "./event-bus.js";

/**
 * 跑一段脚本，记录**可观测行为**。
 *
 * 返回的是「发生了什么」的序列，不是「内部状态」——
 * 因为内部状态（Map 的结构）可以不一样，
 * 但**外部能看到的**必须一样。
 */
function observe(run: (emit: (name: string, payload?: unknown) => void) => void[]): unknown[] {
  const log: unknown[] = [];
  const emit = (name: string, payload?: unknown) => {
    log.push([name, payload]);
  };
  run(emit);
  return log;
}

/** 用 `eventemitter3`（旧）跑一段行为脚本。 */
function observeLegacy(
  script: (bus: {
    on: (n: string, fn: (p?: unknown) => void) => void;
    once: (n: string, fn: (p?: unknown) => void) => void;
    off: (n: string, fn: (p?: unknown) => void) => void;
    emit: (n: string, p?: unknown) => void;
  }) => void,
): unknown[] {
  const bus = new EE();
  const log: unknown[] = [];
  script({
    on: (n, fn) => bus.on(n, fn),
    once: (n, fn) => bus.once(n, fn),
    off: (n, fn) => bus.off(n, fn),
    emit: (n, p) => {
      bus.emit(n, p);
    },
  });
  return log;
}

/** 用新实现跑同一段行为脚本。 */
function observeNew(
  script: (bus: {
    on: (n: string, fn: (p?: unknown) => void) => void;
    once: (n: string, fn: (p?: unknown) => void) => void;
    off: (n: string, fn: (p?: unknown) => void) => void;
    emit: (n: string, p?: unknown) => void;
  }) => void,
): unknown[] {
  const bus = createWorldEventBus();
  const log: unknown[] = [];
  script({
    on: (n, fn) => bus.on(n as never, fn as never),
    once: (n, fn) => bus.once(n as never, fn as never),
    off: (n, fn) => bus.off(n as never, fn as never),
    emit: (n, p) => {
      bus.emit(n as never, p as never);
    },
  });
  return log;
}

/**
 * 断言两个实现在同一段脚本下的行为**逐条相等**。
 */
function expectSameBehavior(
  script: (bus: {
    on: (n: string, fn: (p?: unknown) => void) => void;
    once: (n: string, fn: (p?: unknown) => void) => void;
    off: (n: string, fn: (p?: unknown) => void) => void;
    emit: (n: string, p?: unknown) => void;
  }) => void,
): void {
  const legacy = observeLegacy(script);
  const next = observeNew(script);
  expect(next).toEqual(legacy);
}

describe("事件总线与 eventemitter3 的等价性", () => {
  it("基本订阅和触发", () => {
    expectSameBehavior(({ on, emit }) => {
      const seen: unknown[] = [];
      on("x", (p) => seen.push(p));
      emit("x", 1);
      emit("x", 2);
      expect(seen).toEqual([1, 2]);
    });
  });

  /**
   * **同一个函数订阅两次 → 调用两次**。
   *
   * 这是 `EventTarget` 会做错的地方 ——
   * 规范规定 `addEventListener` 同一个函数加两次**只算一次**。
   * `eventemitter3` 不是这样，React StrictMode 下这个差别直接可见。
   */
  it("同一个函数订阅两次 → 触发两次", () => {
    expectSameBehavior(({ on, emit }) => {
      const seen: unknown[] = [];
      const fn = (p?: unknown) => seen.push(p);
      on("x", fn);
      on("x", fn);
      emit("x", "a");
      expect(seen).toEqual(["a", "a"]);
    });
  });

  /**
   * `off` 摘掉**所有**注册（`on` 的和 `once` 的都摘）。
   */
  it("off 摘掉全部注册", () => {
    expectSameBehavior(({ on, once, off, emit }) => {
      const seen: unknown[] = [];
      const fn = (p?: unknown) => seen.push(p);
      on("x", fn);
      once("x", fn);
      off("x", fn);
      emit("x");
      expect(seen).toEqual([]);
    });
  });

  /**
   * `once` 只触发一次。
   */
  it("once 只触发一次", () => {
    expectSameBehavior(({ once, emit }) => {
      const seen: unknown[] = [];
      once("x", (p) => seen.push(p));
      emit("x", 1);
      emit("x", 2);
      expect(seen).toEqual([1]);
    });
  });

  /**
   * `once` 在**触发前**就摘掉 ——
   * 所以回调里再 `emit` 同一个事件不会递归。
   *
   * 这是最容易写错的一条：先调后摘 → 无限递归 → 栈溢出。
   */
  it("once 在触发前摘掉 —— 回调里重入不递归", () => {
    expectSameBehavior(({ once, emit }) => {
      const seen: unknown[] = [];
      once("x", () => {
        seen.push("called");
        emit("x");
      });
      emit("x");
      expect(seen).toEqual(["called"]);
    });
  });

  /**
   * 触发期间**修改订阅列表不影响本次触发** ——
   * 本次触发遍历的是快照。
   */
  it("触发期间新增订阅不参与本次触发", () => {
    expectSameBehavior(({ on, emit }) => {
      const seen: unknown[] = [];
      on("x", () => {
        seen.push("first");
        on("x", () => seen.push("added-during-emit"));
      });
      emit("x");
      expect(seen).toEqual(["first"]);
      // 下一次才生效
      emit("x");
      expect(seen).toEqual(["first", "first", "added-during-emit"]);
    });
  });

  /**
   * 触发期间**取消订阅**不影响本次触发 ——
   * 本次触发遍历的是快照。
   */
  it("触发期间取消订阅不影响本次触发", () => {
    expectSameBehavior(({ on, off, emit }) => {
      const seen: unknown[] = [];
      const second = (p?: unknown) => seen.push("second");
      on("x", () => {
        seen.push("first");
        off("x", second);
      });
      on("x", second);
      emit("x");
      expect(seen).toEqual(["first", "second"]);
      // 下一次才生效
      emit("x");
      expect(seen).toEqual(["first", "second", "first"]);
    });
  });

  /**
   * 按**注册顺序**触发。
   */
  it("按注册顺序触发", () => {
    expectSameBehavior(({ on, emit }) => {
      const seen: unknown[] = [];
      on("x", () => seen.push(1));
      on("x", () => seen.push(2));
      on("x", () => seen.push(3));
      emit("x");
      expect(seen).toEqual([1, 2, 3]);
    });
  });

  /**
   * 没有监听器时 `emit` 是**空操作**（不抛）。
   */
  it("没有监听器时 emit 不抛", () => {
    expectSameBehavior(({ emit }) => {
      emit("nobody-listens");
    });
  });

  /**
   * `off` 一个**没订阅过**的事件 —— 空操作。
   */
  it("off 没订阅过的事件不抛", () => {
    expectSameBehavior(({ off }) => {
      off("never-used", () => {});
    });
  });

  /**
   * 不同事件互不干扰。
   */
  it("不同事件互不干扰", () => {
    expectSameBehavior(({ on, emit }) => {
      const seen: unknown[] = [];
      on("a", () => seen.push("a"));
      on("b", () => seen.push("b"));
      emit("a");
      emit("b");
      emit("a");
      expect(seen).toEqual(["a", "b", "a"]);
    });
  });
});
