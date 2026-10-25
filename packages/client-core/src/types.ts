/**
 * 地图数据层的类型契约。
 *
 * ## 这里为什么是「一份」
 *
 * 改造前有两份逐字相同的定义：
 *
 * - `client/src/types/api.ts` 的 `MainAreaPointInfo`
 * - `packages/core/src/contracts/world.ts` 的 `MainAreaPointConfig`
 *
 * 字段一模一样，只是名字不同。阶段 4 刚处理过同一类问题
 * （core 和 orchestrator 各有一份逐字重复的 `normalizeLocations`），
 * 再留一份就是在复发。
 *
 * 所以这里**直接用 core 的类型**，不另起一份。
 * `MainAreaPointInfo` 作为别名保留 —— client 侧的老名字不改，
 * 只是它现在指向 core 的那一个定义。
 */

import type { MainAreaPointConfig } from "@worldx/core";

/**
 * 主区域点位 —— 直接用 core 的定义。
 *
 * client 侧原来的名字是 `MainAreaPointInfo`，作为别名保留，
 * 免得改动 client 的一堆 import。
 */
export type MainAreaPointInfo = MainAreaPointConfig;

/** 地图上的一个区域（矩形） */
export interface LocationRect {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * true = 这是**合成**出来的（TMJ 没有 regions 层时的兜底），
   * 不是地图上真实存在的区域。
   */
  synthetic?: boolean;
}

/** 地图上的一个可交互物件 */
export interface InteractiveObject {
  objectId: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 主区域的一个点位 */
export type MainAreaPointNode = MainAreaPointConfig;

/** 网格坐标 */
export interface GridPoint {
  gx: number;
  gy: number;
}

/** 像素坐标 */
export interface PixelPoint {
  x: number;
  y: number;
}

/** 走一步的轴向 */
export type StepAxis = "h" | "v";
