/**
 * `@own-world/client-core` —— 框架无关的地图数据层。
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
 * - `@own-world/core` —— 只取 `contracts` 层的类型和 `DEFAULT_CENTER_LOCATION_ID`。
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
 * TMJ 解析在 `@own-world/core` —— core 本身就在读 TMJ
 * （`world-manager.ts` 重建点位邻接、推断地图尺寸），
 * 解析器放 client-core 会让依赖成环。
 *
 * 这里 re-export 出来，是因为 client 用它读地图 —— 它属于「地图数据层」
 * 的对外接口的一部分。
 *
 * ## 为什么用子路径，不从包根导入
 *
 * 从 `@own-world/core` 根导入会把**整个 core** 拉进 client 的模块图 ——
 * 包括 `engine/world-manager.js`，它 `import fs from "node:fs"`，
 * 顶层还读 `process.env`。
 *
 * 现在浏览器里靠 tree-shaking 恰好摇掉了（bundle 里搜不到 `process.env`），
 * 但那是**运气**：world-manager 一旦有顶层副作用，浏览器里就会
 * `process is not defined` 崩掉。
 *
 * 子路径导入把依赖面缩到两个文件：
 * `contracts/world.js`（纯类型 + 一个常量）和 `engine/tmj-parser.js`（纯函数）。
 */
export {
  DEFAULT_TILE_SIZE,
  parseTmj,
  toInteractiveObjects,
  toLocationRects,
  gridToPixel,
  pixelToGrid,
} from "@own-world/core/engine/tmj-parser.js";
export type {
  ParsedTmj,
  TmjBackground,
  TmjObject,
} from "@own-world/core/engine/tmj-parser.js";

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
export { DEFAULT_CENTER_LOCATION_ID } from "@own-world/core/contracts/world.js";
