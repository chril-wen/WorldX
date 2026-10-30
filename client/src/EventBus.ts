/**
 * 事件总线的**出口** —— 现在指向 client-core 的新总线。
 *
 * ## 为什么保留这个文件
 *
 * 8.3 之前它长这样：
 *
 * ```
 * import Phaser from "phaser";
 *
 * export class EventBus {
 *   static instance: Phaser.Events.EventEmitter = new Phaser.Events.EventEmitter();
 * }
 * ```
 *
 * 改完之后它变成**转发**。
 *
 * 为什么不直接删掉、让 4 个消费者各自 import client-core 的单例？
 * 因为 8.4 才下线旧 Phaser 层 —— 这时候保留一个**稳定的出口**，
 * 8.4 再把它删掉，改动集中在一个文件里，而不是散在 4 个地方。
 *
 * ## 单例还是每次新建
 *
 * **单例** —— 这是**照搬原行为**，不是新设计。
 *
 * 生产侧（`WorldScene` / `CameraController` / `PlaybackController`）
 * 和面板侧（`App.tsx` / `MapControls.tsx`）拿的必须是**同一个**实例，
 * 否则面板发的指令生产侧收不到。
 *
 * 原实现就是 `static instance`（全局单例），这里保持一致。
 */

import { worldEventBus } from "@own-world/client-core";
import type { WorldEventBus } from "@own-world/client-core";

export class EventBus {
  /**
   * 全局唯一的事件总线。
   *
   * 类型是契约的 `WorldEventBus` —— 不是 Phaser 的 `EventEmitter`。
   *
   * 契约的 `emit` 返回 `void`，Phaser 的返回 `this`；
   * 契约没有 `removeAllListeners` / `eventNames` 这些方法。
   * **现有代码一个都没用到**（实测过），
   * 所以换成契约类型是**零行为变更**。
   */
  static instance: WorldEventBus = worldEventBus;
}
