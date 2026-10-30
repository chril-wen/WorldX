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

/**
 * 渲染契约 —— 阶段 8 的「要画什么」和「说什么」。
 *
 * **只导出类型，不导出实现** —— 这一层是纯契约，
 * 渲染实现（Canvas 2D / Pixi / SVG）各自实现 `SceneRenderer`，
 * 只依赖这里定义的类型。
 *
 * 导出的是**类型**，所以对客户端 bundle 体积的影响是零
 * （TS 的 `export type` 在编译后不留任何运行时代码）。
 */
export type {
  CameraState,
  DrawEllipse,
  DrawImage,
  DrawItem,
  DrawPolygon,
  DrawPolyline,
  DrawRect,
  DrawSprite,
  DrawText,
  HitArea,
  OverlayItem,
  RenderLayer,
  RenderScene,
  SceneRenderer,
} from "./render/render-model.js";

export {
  screenToWorld,
  worldToScreen,
} from "./render/render-model.js";

/**
 * Canvas 2D 渲染实现 —— 阶段 8.2。
 *
 * 契约（`render-model.ts`）的**第一个**消费者。
 *
 * 导出的是**实现**，不是类型 —— 因为渲染实现是**可换的**：
 * 换栈的时候只要还实现 `SceneRenderer`，上层一行都不用改。
 */
export {
  Canvas2DSceneRenderer,
} from "./render/canvas2d/canvas2d-renderer.js";
export type {
  Canvas2DRendererOptions,
  CanvasFactory,
  Surface2D,
  SurfaceCanvas,
} from "./render/canvas2d/canvas2d-renderer.js";

export {
  DomOverlayRenderer,
} from "./render/canvas2d/dom-overlays.js";
export type { OverlayRendererOptions } from "./render/canvas2d/dom-overlays.js";

export {
  buildSpriteSheetFrames,
  defaultImageLoader,
} from "./render/canvas2d/textures.js";
export type {
  ImageLoader,
  Texture,
  TextureFrame,
  TextureSpec,
} from "./render/canvas2d/textures.js";

/**
 * 角色贴图集的**格子尺寸**从哪来。
 *
 * 格子大小**跟着图片尺寸走**（老图 170×204，新图 174×209）——
 * 写死一个数会让贴图窗口错位，角色的脚会跑到头顶上。
 *
 * 生成器早就把真值写进 `metadata.json` 了，只是从来没人读。
 */
export {
  characterMetadataUrl,
  DEFAULT_SPRITE_COLUMNS,
  DEFAULT_SPRITE_FRAME_HEIGHT,
  DEFAULT_SPRITE_FRAME_WIDTH,
  DEFAULT_SPRITE_ROWS,
  defaultSpriteMetadataLoader,
  deriveSpriteFrameSize,
  loadCharacterSpriteFrameSize,
  parseCharacterSpriteMetadata,
  resolveSpriteFrameSize,
} from "./render/sprite-metadata.js";
export type {
  CharacterFrameSizeLoaders,
  CharacterSpriteMetadata,
  SpriteFrameSize,
  SpriteFrameSizeSources,
  SpriteImageSizeLoader,
  SpriteMetadataLoader,
} from "./render/sprite-metadata.js";

/**
 * 场景构建器 —— 把「世界状态」翻译成「要画什么」。
 *
 * **位置计算全在这里**（client-core），渲染实现只负责乘变换矩阵。
 *
 * 跟 `render-model.ts` 分开是刻意的：
 * 契约层是**类型**（不能改），构建器是**实现**（可以迭代）。
 */
export {
  buildRenderScene,
  getBubbleAnchorOffsetY,
  getHeadWorldOffset,
  getIdleFrame,
  getSortFootY,
  hitTestScene,
  resolveCharacterPlacements,
  SCENE_LAYER_DEPTHS,
  SCENE_LAYER_IDS,
} from "./render/scene-builder.js";
export type {
  CharacterRenderState,
  DebugOverlayToggles,
  DialogueBubbleState,
  FacingDirection,
  SceneBuilderInput,
  TextMeasurer,
} from "./render/scene-builder.js";

/**
 * 角色的显示度量 —— 世界单位的尺寸。
 *
 * 跟着位置逻辑一起搬进 client-core：
 * 气泡挂多高、名牌挂多高、谁盖住谁 —— 这些都是位置。
 */
export {
  actionToEmoji,
  createCharacterDisplayMetrics,
  getCharacterColor,
  toCssColor,
  ACTION_EMOJI,
  CHARACTER_COLORS,
  SPRITE_COLUMNS,
  SPRITE_FRAME_HEIGHT,
  SPRITE_FRAME_WIDTH,
  SPRITE_ROWS,
  SPRITE_WALK_FRAME_RATE,
} from "./render/character-metrics.js";
export type { CharacterDisplayMetrics } from "./render/character-metrics.js";

export type {
  CameraStatePayload,
  CharacterSummary,
  ClientWorldTime,
  PlaybackMode,
  ReplayInitFrame,
  SimulationStatus,
  WorldEventBus,
  WorldEventMap,
  WorldEventName,
} from "./render/events.js";
