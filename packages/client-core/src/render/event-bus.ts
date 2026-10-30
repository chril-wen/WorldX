/**
 * 事件总线的**实现** —— 零依赖，不碰 Phaser。
 *
 * ## 为什么单独一个文件
 *
 * `events.ts` 定的是**契约**（事件名 + 载荷类型），
 * 这个文件是**实现**。
 *
 * 分开是因为 8.0 的规矩：契约先定死，实现后补。
 * 契约里只有类型，实现放在外面 ——
 * 这样「契约」不会因为「实现怎么写」而变形。
 *
 * ## 为什么不用 `EventTarget`
 *
 * `events.ts` 最初写的是「用 `EventTarget` 实现」。
 * 落地时发现**语义对不上**，而且差的地方正好会咬人：
 *
 * | 行为 | `EventTarget` | `eventemitter3`（现在的实现） |
 * |---|---|---|
 * | 同一个回调订阅两次 | **只存一份**（规范去重） | **存两份**，触发两次 |
 * | `off` 的匹配 | 只能按**函数引用** | 按函数引用，**且能按 context 区分** |
 * | `emit` 时修改订阅列表 | 按规范快照 | 按快照（`removeListener` 换新数组） |
 *
 * 第一条是硬伤：`EventTarget` 的
 * 「`addEventListener` 同一个函数加两次只算一次」是**规范行为**，
 * 而 `eventemitter3` 会真的存两份。
 *
 * 面板层有 `useEffect` 订阅 + 清理的成对模式，
 * React 的 StrictMode 会把 effect 跑两遍 ——
 * 两种实现的「订阅次数」在这时**不一样**。
 *
 * 所以这里手写一个**跟 `eventemitter3` 逐条对齐**的实现。
 * 行为一致这件事不是靠「读文档觉得差不多」，
 * 是靠 `client/src/systems/event-bus.ab.test.ts` 里的
 * **等价性对拍**（同一个脚本跑两遍，逐条比对可观测行为）。
 *
 * ## `eventemitter3` 的语义（逐条照抄）
 *
 * - `on` —— 追加。**同一个函数可以订阅多次，会被调用多次**。
 * - `once` —— 追加，但**触发前先摘掉**（所以回调里再 `emit` 同一个事件不会递归）。
 * - `off(event, fn)` —— 摘掉**所有**注册了该函数的监听器
 *   （`once` 的和非 `once` 的都摘）。
 * - `emit` —— 按**注册顺序**调用；触发期间对订阅列表的修改
 *   **不影响本次触发**（遍历的是快照）。
 * - 没有监听器时 `emit` 是空操作。
 *
 * 这些都是 `eventemitter3` 的实际行为，
 * 抄自 `client/node_modules/eventemitter3/index.js`。
 */

import type {
  WorldEventBus,
  WorldEventMap,
  WorldEventName,
} from "./events.js";

/** 一个订阅。 */
interface Subscription {
  /** 回调。 */
  fn: (payload: never) => void;
  /** 是不是一次性的（`once`）。 */
  once: boolean;
}

/**
 * 建一个事件总线。
 *
 * 每次调用返回**独立**的实例 —— 单例是下面那个
 * `worldEventBus`，这里是为了**能测**（单测里各测各的）。
 */
export function createWorldEventBus(): WorldEventBus {
  /** 事件名 → 订阅列表。 */
  const subscriptions = new Map<WorldEventName, Subscription[]>();

  /** 摘掉某个事件下的某个回调（所有注册）。 */
  function removeListener(
    event: WorldEventName,
    fn: (payload: never) => void,
  ): void {
    const list = subscriptions.get(event);
    if (!list) return;

    const kept = list.filter((s) => s.fn !== fn);
    if (kept.length === 0) {
      subscriptions.delete(event);
    } else {
      subscriptions.set(event, kept);
    }
  }

  /** 追加一个订阅。 */
  function addListener(
    event: WorldEventName,
    fn: (payload: never) => void,
    once: boolean,
  ): void {
    const list = subscriptions.get(event);
    const subscription: Subscription = { fn, once };
    if (list) {
      list.push(subscription);
    } else {
      subscriptions.set(event, [subscription]);
    }
  }

  return {
    on<K extends WorldEventName>(
      event: K,
      listener: (payload: WorldEventMap[K]) => void,
    ): void {
      addListener(
        event,
        listener as unknown as (payload: never) => void,
        false,
      );
    },

    off<K extends WorldEventName>(
      event: K,
      listener: (payload: WorldEventMap[K]) => void,
    ): void {
      removeListener(
        event,
        listener as unknown as (payload: never) => void,
      );
    },

    once<K extends WorldEventName>(
      event: K,
      listener: (payload: WorldEventMap[K]) => void,
    ): void {
      addListener(
        event,
        listener as unknown as (payload: never) => void,
        true,
      );
    },

    emit<K extends WorldEventName>(
      event: K,
      ...args: WorldEventMap[K] extends void
        ? [payload?: undefined]
        : [payload: WorldEventMap[K]]
    ): void {
      const list = subscriptions.get(event);
      if (!list || list.length === 0) return;

      /**
       * **遍历快照** —— 触发期间的订阅变更不影响本次触发。
       *
       * 这跟 `eventemitter3` 一致：它的 `removeListener`
       * 是**换一个新数组**，不是就地改，所以正在遍历的旧数组不受影响。
       *
       * 同理，回调里新订阅的监听器**本次不会被调用**。
       */
      const snapshot = list.slice();

      for (const subscription of snapshot) {
        /**
         * 一次性的**先摘再调** —— 跟 `eventemitter3` 一样。
         *
         * 这样回调里再 `emit` 同一个事件，不会把自己又调一遍
         * （那是递归，不是重入）。
         */
        if (subscription.once) {
          removeListener(event, subscription.fn);
        }
        subscription.fn(args[0] as never);
      }
    },
  };
}

/**
 * 全局唯一的事件总线。
 *
 * ## 为什么是单例
 *
 * 现在是这样用的（`client/src/EventBus.ts`）：
 *
 * ```
 * export class EventBus {
 *   static instance: Phaser.Events.EventEmitter = new Phaser.Events.EventEmitter();
 * }
 * ```
 *
 * 生产侧（`WorldScene` / `CameraController` / `PlaybackController`）
 * 和面板侧（`App.tsx` / `MapControls.tsx`）拿的是**同一个**实例 ——
 * 这是现有行为，改成单例是**照搬**，不是新设计。
 *
 * 改造后 `client/src/EventBus.ts` 会变成对它的转发，
 * 好处是**面板层直接 import 这个单例**时，
 * 不需要再经过 client 的 `EventBus.ts` ——
 * 那个文件是要在 8.4 下线掉的。
 */
export const worldEventBus: WorldEventBus = createWorldEventBus();
