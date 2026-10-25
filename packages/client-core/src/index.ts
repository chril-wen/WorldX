/**
 * `@worldx/client-core` —— 框架无关的地图数据层。
 *
 * ## 这里放什么
 *
 * **地图是什么**（数据），不是**地图怎么画**（渲染）。
 *
 * `MapManager` 解析 TMJ、维护碰撞网格、回答「这个像素在哪个区域」
 * 「这个角色该站哪」；`PathfindingManager` 在网格上找路径。
 * 两者都**不碰 Phaser、不碰 React、不碰 DOM** —— 任何前端都能直接用。
 *
 * ## 依赖
 *
 * - `@worldx/core` —— 只取 `contracts` 层的类型和 `DEFAULT_CENTER_LOCATION_ID`。
 *   core 本身零 Phaser（阶段 1 验收过），所以这不违反「框架无关」。
 * - `easystarjs` —— A* 实现。**寻路本身必须在包里**，
 *   否则每个新 UI 都要自己实现一遍。
 *
 * ## 类型从哪来
 *
 * `MainAreaPointNode` 直接用 core 的 `MainAreaPointConfig` ——
 * 改造前 client 的 `MainAreaPointInfo` 和 core 的 `MainAreaPointConfig`
 * 字段逐字相同，是同一份东西的两个名字。现在只有一份。
 */

export {
  MapManager,
} from "./map-model.js";
export type {
  InteractiveObject,
  LocationRect,
  MainAreaPointNode,
} from "./map-model.js";

export {
  PathfindingManager,
} from "./pathfinding.js";

/**
 * TMJ 解析在 `@worldx/core` —— core 本身就在读 TMJ
 * （`world-manager.ts` 重建点位邻接、推断地图尺寸），
 * 解析器放 client-core 会让依赖成环。
 *
 * 这里 re-export 出来，是因为 client 用它读地图 —— 它属于「地图数据层」
 * 的对外接口的一部分。
 */
export {
  DEFAULT_TILE_SIZE,
  parseTmj,
  toInteractiveObjects,
  toLocationRects,
  gridToPixel,
  pixelToGrid,
} from "@worldx/core";
export type {
  ParsedTmj,
  TmjBackground,
  TmjObject,
} from "@worldx/core";

export type {
  GridPoint,
  LocationInfo,
  MainAreaPointInfo,
  PixelPoint,
  StepAxis,
} from "./types.js";

/**
 * 中心区域的默认 id —— 世界的公共枢纽。
 *
 * 直接 re-export core 的那一份 —— 改造前 client 和 core 各定义一次，
 * 值相同，注释里还互相声明「是同一个值」。
 */
export { DEFAULT_CENTER_LOCATION_ID } from "@worldx/core";
