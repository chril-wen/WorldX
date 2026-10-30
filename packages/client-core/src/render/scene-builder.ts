/**
 * 场景构建器 —— 把「世界状态」翻译成「要画什么」。
 *
 * ## 这一层是干什么的
 *
 * 阶段 8 要换掉 Phaser 渲染层。换栈的前提是**位置逻辑只写一遍** ——
 * 写在渲染实现里的话，换栈就得重抄一遍，抄错了角色会站错地方。
 *
 * 所以：**位置计算全在这里，渲染实现只负责乘变换矩阵。**
 *
 * ```
 * 世界状态（地图 + 角色 + 气泡 + 覆盖层开关）
 *        │
 *        ▼
 *   buildRenderScene()  ← 本文件，在 client-core 里，纯数据
 *        │
 *        ▼
 *   RenderScene（世界坐标的图元 + 屏幕坐标的覆盖层）
 *        │
 *        ▼
 *   渲染实现（Canvas 2D / Pixi / SVG）—— 只画，不算位置
 * ```
 *
 * ## 为什么输入是「角色渲染状态」而不是「角色数据」
 *
 * 位置有**两个来源**：
 *
 * 1. 世界里的逻辑位置（角色在中心区域的哪个点位）—— 由 `MapManager` 决定
 * 2. 画面上的像素位置 —— 由 1 加上偏移（气泡挂头顶、名牌挂头顶）决定
 *
 * 第 1 类是**地图数据层**的事（`MapManager.getMainAreaPlacement()`），
 * 这里直接复用它，不重算。
 *
 * ## 不碰什么
 *
 * **不碰 canvas、不碰 Phaser、不碰 DOM、不碰 React。**
 * 这一层是纯数据 —— 跟 `render-model.ts` 一个性质。
 *
 * ## 角色放哪：跟改造前逐字一致
 *
 * 改造前这套逻辑在 `WorldScene.getCharacterPlacement()`：
 *
 * ```ts
 * (char.location === center && char.mainAreaPointId
 *   ? mapManager.getMainAreaPlacement(char.mainAreaPointId, char.id, { occupantIds })
 *   : null)
 * || mapManager.getRandomWalkablePointInLocation(char.location, { preferInset })
 * || { x: 400, y: 300 }
 * ```
 *
 * **逐字搬过来了** —— 包括最后的 `{ x: 400, y: 300 }` 兜底。
 * 逻辑一样，但**代码只有一份**：在 client-core 里。
 */

import type { MapManager } from "../map-model.js";
import {
  actionToEmoji,
  createCharacterDisplayMetrics,
  getCharacterColor,
  toCssColor,
  type CharacterDisplayMetrics,
} from "./character-metrics.js";
import type {
  CameraState,
  DrawItem,
  DrawRect,
  DrawText,
  OverlayItem,
  RenderLayer,
  RenderScene,
} from "./render-model.js";
import { worldToScreen } from "./render-model.js";

/* ── 调试覆盖层的开关 ──────────────────────────────────────────── */

/**
 * 四个调试覆盖层的开关。
 *
 * 跟现有 `toggle_debug_*_overlay` 事件一一对应。
 */
export interface DebugOverlayToggles {
  /** 可行走区域（调试用）。 */
  walkable: boolean;
  /** 区域框。 */
  regionBounds: boolean;
  /** 中心区域点位。 */
  mainAreaPoints: boolean;
  /** 可交互物件。 */
  interactiveObjects: boolean;
}

/* ── 角色与气泡 ────────────────────────────────────────────────── */

/** 角色面朝的方向 —— 决定站桩帧和贴图翻转。 */
export type FacingDirection = "down" | "up" | "left" | "right";

/**
 * 一个角色的渲染状态。
 *
 * **只有「渲染需要知道的」，没有「业务需要的」** ——
 * 情绪、背景故事这些不进这一层（面板层要的话走 API）。
 */
export interface CharacterRenderState {
  id: string;
  name: string;
  /** 角色当前所在的区域 id。 */
  location: string;
  /** 中心区域里的点位 id（不在中心区域时为 null）。 */
  mainAreaPointId?: string | null;
  /**
   * 贴图的纹理 key —— 有贴图时用它画精灵，没有就用圆兜底。
   *
   * `null` / `undefined` = 没有贴图。
   */
  spriteSource?: string | null;
  /** 面朝方向。默认 `"down"`。 */
  facing?: FacingDirection;
  /**
   * 兜底圆的颜色序号（按角色在列表里的次序）。
   *
   * 没有贴图时才用得上 —— 不同角色不同颜色，一堆角色挤一起能分清。
   */
  colorIndex?: number;
  /** 当前动作（用来算图标）。 */
  action?: string | null;
  /** 动作标签（名牌上的药丸）。 */
  actionLabel?: string | null;
  /**
   * 显式指定位置。
   *
   * 给了就用它（移动中的角色），
   * 不给就由 builder 按 `location` + `mainAreaPointId` 算（同步角色时）。
   */
  x?: number;
  y?: number;
}

/** 一个对话气泡。 */
export interface DialogueBubbleState {
  /** 说话的角色 id。 */
  characterId: string;
  /** 气泡主文本。 */
  content: string;
  /** 内心独白（可选）。 */
  innerMonologue?: string;
  /**
   * 显式指定气泡锚点的世界坐标。
   *
   * 不给就用说话角色的位置 + 头顶偏移。
   */
  x?: number;
  y?: number;
}

/* ── 构建器的输入 ──────────────────────────────────────────────── */

/**
 * 文字测量 —— 渲染实现（或宿主）提供。
 *
 * ## 为什么需要它
 *
 * 旧实现里「区域名」是**带深色底的 chip**，宽度取决于文字多宽。
 * 要算出 chip 的矩形，就得知道文字有多宽 —— 而这需要字体引擎。
 *
 * client-core 不做字体测量（那是渲染实现的事），
 * 所以这里用一个**注入的回调**：给了就精确还原 chip，
 * 不给就只画文字（chip 由渲染实现按自己的风格补）。
 *
 * ## 返回值的语义
 *
 * 返回的是**文字本身的尺寸，不含描边**（相当于 `canvas.measureText()`）。
 *
 * 描边由 builder 自己加 —— 因为**加了描边，尺寸会变大**，
 * 而「加多少」是 builder 的决定（它决定画不画描边），
 * 不该让测量函数替它决定。
 *
 * 加法照抄 Phaser 的 `GetTextSize`：
 *
 * ```
 * 宽 = ceil(文字宽 + 描边粗细)
 * 高 = 文字高 + 描边粗细
 * ```
 */
export type TextMeasurer = (
  text: string,
  font: string,
) => { width: number; height: number };

/** 构建一个场景需要的全部输入。 */
export interface SceneBuilderInput {
  /** 地图数据层 —— 位置计算全靠它。 */
  map: MapManager;
  /** 相机状态（世界坐标 → 屏幕坐标的变换）。 */
  camera: CameraState;
  /** 地图底图。 */
  background: {
    /** 纹理 key。 */
    source: string;
    width: number;
    height: number;
  };
  /** 角色列表。 */
  characters: CharacterRenderState[];
  /** 对话气泡（可空）。 */
  bubbles?: DialogueBubbleState[];
  /** 调试覆盖层开关（可空 = 全关）。 */
  overlays?: Partial<DebugOverlayToggles>;
  /**
   * 当前悬停的可交互物件 id（可空）。
   *
   * 悬停高亮是**即时反馈** —— 鼠标移上去就要变，
   * 所以它不进角色状态，单独一个字段。
   */
  hoveredObjectId?: string | null;
  /** 当前悬停的角色 id（可空）—— 决定贴图染色 / 圆圈描边。 */
  hoveredCharacterId?: string | null;
  /**
   * 角色的显示度量。
   *
   * 不给就按地图尺寸算（跟旧实现一样）。
   */
  displayMetrics?: CharacterDisplayMetrics;
  /** 文字测量（可空）—— 给了才能精确还原带底色的标签。 */
  measureText?: TextMeasurer;
}

/* ── 图层 id ───────────────────────────────────────────────────── */

/**
 * 图层 id —— 固定这几个，渲染实现可以按 id 做特例（比如整层跳过）。
 */
export const SCENE_LAYER_IDS = {
  /** 可行走区域覆盖层。 */
  walkable: "walkable-overlay",
  /** 角色层（按脚底 y 排序）。 */
  characters: "characters",
  /** 悬停高亮。 */
  hoverHighlight: "hover-highlight",
  /** 区域框。 */
  regionBounds: "region-bounds",
  /** 中心区域点位。 */
  mainAreaPoints: "main-area-points",
  /** 可交互物件框。 */
  interactiveObjects: "interactive-objects",
  /** 悬停标签（背景 + 文字）。 */
  hoverLabel: "hover-label",
  /** 区域名 / 物件名文字。 */
  labels: "labels",
} as const;

/**
 * 图层深度 —— **跟改造前的 Phaser 一致**。
 *
 * 改造前这些是散落在 `WorldScene` 里的 `setDepth()` 调用，
 * 这里把它们收成一张表。
 */
export const SCENE_LAYER_DEPTHS = {
  walkable: 4,
  characters: 10,
  hoverHighlight: 15,
  regionBounds: 16,
  mainAreaPoints: 16,
  interactiveObjects: 16,
  hoverLabel: 16,
  labels: 17,
} as const;

/* ── 旧实现里的样式常量 ────────────────────────────────────────── */

/**
 * 旧实现里的样式常量 —— **逐字搬过来**。
 *
 * 这些是「观感」的一部分（改了界面就变了），但它们也是
 * 「这个覆盖层长什么样」的唯一来源 —— 抄一份到渲染实现里
 * 就等于把样式拆成两处，改一处忘一处。
 *
 * 放在这里而不是渲染实现里，是因为渲染契约的颜色/字号
 * 已经是「数据」的一部分（见 `render-model.ts`）。
 */
const OVERLAY_STYLE = {
  walkable: {
    fill: toCssColor(0x4da3ff),
    fillAlpha: 0.22,
    stroke: toCssColor(0x7db8ff),
    strokeAlpha: 0.16,
    lineWidth: 1,
  },
  regionBounds: {
    fill: toCssColor(0xffd166),
    fillAlpha: 0.08,
    stroke: toCssColor(0xffd166),
    strokeAlpha: 0.95,
    lineWidth: 2,
  },
  mainAreaPoints: {
    fill: toCssColor(0x4da3ff),
    fillAlpha: 0.95,
    innerFill: toCssColor(0xe8f4ff),
    stroke: toCssColor(0xffffff),
    strokeAlpha: 0.92,
    lineWidth: 2,
    radius: 6,
    innerRadius: 2,
  },
  interactiveObjects: {
    fill: toCssColor(0x55efc4),
    fillAlpha: 0.1,
    stroke: toCssColor(0x55efc4),
    strokeAlpha: 0.95,
    lineWidth: 2,
  },
  hover: {
    fill: toCssColor(0xffffff),
    fillAlpha: 0.15,
    stroke: toCssColor(0xffffff),
    strokeAlpha: 0.8,
    lineWidth: 2,
    radius: 4,
  },
  hoverLabelBg: {
    fill: toCssColor(0x000000),
    fillAlpha: 0.75,
    radius: 6,
    paddingX: 12,
    paddingY: 8,
  },
} as const;

/** 区域名 / 物件名的字体与颜色（跟旧实现一致）。 */
const LABEL_FONT = "14px 'PingFang SC', 'Microsoft YaHei', sans-serif";
const REGION_LABEL_COLOR = "#ffe7a8";
const OBJECT_LABEL_COLOR = "#c8fff0";
/** 悬停标签的字体（比区域名大一号）。 */
const HOVER_LABEL_FONT = "18px 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif";
const HOVER_LABEL_COLOR = "#ffffff";

/**
 * 带深色底的标签（chip）的内边距 —— 跟旧实现一致。
 *
 * ## 为什么内边距要算进去
 *
 * Phaser 的 `Text` 带 `padding` 时：
 *
 * - 文本框 = **文字盒 + 左右内边距** × **文字盒 + 上下内边距**
 * - 文字本身画在 `(x + padding.left, y + padding.top)`
 *
 * 所以 chip 是「底 + 文字」两个图元，位置差一个内边距。
 * 少算这一步，标签会比旧实现大一圈。
 */
const CHIP_PADDING = { left: 6, right: 6, top: 3, bottom: 3 } as const;

/** 标签的黑色描边 —— 跟旧实现一致（`stroke: "#000000", strokeThickness: 2`）。 */
const LABEL_STROKE = "#000000";
const LABEL_STROKE_THICKNESS = 2;
/** 悬停标签的描边粗细 —— 旧实现里也是 2。 */
const HOVER_LABEL_STROKE_THICKNESS = 2;

/**
 * 量一个文本框的尺寸 —— **照抄 Phaser 的 `GetTextSize`**。
 *
 * ```
 * 宽 = ceil(文字宽 + 描边粗细)
 * 高 = 文字行高 + 描边粗细
 * ```
 *
 * 描边**占尺寸** —— 它往外画，所以文本框会变大。
 * 这一步漏了，chip 会比旧实现窄一点（正好差一个描边粗细）。
 */
function measureTextBox(
  measureText: TextMeasurer,
  content: string,
  font: string,
  strokeThickness: number,
): { width: number; height: number } {
  const raw = measureText(content, font);
  return {
    width: Math.ceil(raw.width + strokeThickness),
    height: raw.height + strokeThickness,
  };
}

/**
 * 做一个「带深色底的标签」。
 *
 * 返回一个图元（文字自带背景）。
 *
 * @param x 标签左上角（**框的外沿**）
 * @param y 标签左上角（**框的外沿**）
 */
function buildChipLabel(
  idPrefix: string,
  x: number,
  y: number,
  content: string,
  font: string,
  color: string,
  measureText?: TextMeasurer,
): DrawItem {
  const item: DrawText = {
    kind: "text",
    id: idPrefix,
    x,
    y,
    content,
    font,
    color,
    stroke: LABEL_STROKE,
    strokeThickness: LABEL_STROKE_THICKNESS,
    background: "#000000",
    backgroundAlpha: 0.65,
    padding: { ...CHIP_PADDING },
  };

  // 有测量函数时，把**框的尺寸**也带上 ——
  // 渲染实现没有字体引擎，算不出 chip 该画多大。
  const measured = measureText?.(content, font);
  if (measured) {
    const box = measureTextBox(
      measureText!,
      content,
      font,
      LABEL_STROKE_THICKNESS,
    );
    item.width = box.width + CHIP_PADDING.left + CHIP_PADDING.right;
    item.height = box.height + CHIP_PADDING.top + CHIP_PADDING.bottom;
  }

  return item;
}

/* ── 角色几何（跟旧 CharacterSprite 一致）───────────────────────── */

/**
 * 角色脚底到头顶的距离（世界单位）。
 *
 * **逐字搬自**旧 `CharacterSprite.getHeadWorldOffset()`。
 *
 * 有贴图：贴图显示高 × originY(0.85) × 0.85（切掉透明边）。
 * 无贴图：圆半径 × 1.1。
 */
export function getHeadWorldOffset(
  metrics: CharacterDisplayMetrics,
  hasSprite: boolean,
): number {
  if (hasSprite) {
    return metrics.spriteHeight * 0.85 * 0.85;
  }
  return metrics.circleRadius + metrics.circleRadius * 0.1;
}

/**
 * 气泡挂在头顶的偏移（世界单位，向上为负）。
 *
 * **逐字搬自**旧 `CharacterSprite.getBubbleAnchorOffsetY()`。
 */
export function getBubbleAnchorOffsetY(
  metrics: CharacterDisplayMetrics,
  hasSprite: boolean,
): number {
  return hasSprite ? metrics.bubbleOffsetY : -metrics.circleRadius * 4.2;
}

/**
 * 角色的排序脚底 y —— 决定谁盖住谁。
 *
 * **逐字搬自**旧 `CharacterSprite.getSortFootY()`。
 */
export function getSortFootY(
  metrics: CharacterDisplayMetrics,
  hasSprite: boolean,
  y: number,
): number {
  return y + (hasSprite ? metrics.sortFootYOffset : metrics.circleRadius * 0.65);
}

/* ── 角色站位 ──────────────────────────────────────────────────── */

/**
 * 算每个角色应该站哪。
 *
 * **逐字搬自**旧 `WorldScene.getCharacterPlacement()` + 它上游的
 * `mainAreaOccupants` 统计。
 *
 * 关键点：
 *
 * - 中心区域里的角色按 `mainAreaPointId` **站到点位上**，
 *   同一个点位有多个角色时按 id 排序错开（`MapManager` 负责）。
 * - 其他区域的角色**随机**站一个可走的点。
 * - 都不行就退到 `{ x: 400, y: 300 }` —— 旧实现就是这个兜底，
 *   一个角色都不显示比角色显示在奇怪的地方更糟。
 */
export function resolveCharacterPlacements(
  map: MapManager,
  characters: CharacterRenderState[],
): Array<{ character: CharacterRenderState; x: number; y: number }> {
  // 谁占了中心区域的哪个点位。
  //
  // 统计顺序跟旧实现一致（按 characters 的顺序）——
  // `MapManager.getMainAreaPlacement()` 内部会再按 id 排序，
  // 但 occupant 列表的**集合**必须一样，分配结果才一样。
  const mainAreaOccupants = new Map<string, string[]>();
  const centerLocationId = map.getCenterLocationId();
  for (const character of characters) {
    if (character.location !== centerLocationId || !character.mainAreaPointId) continue;
    const occupants = mainAreaOccupants.get(character.mainAreaPointId) ?? [];
    occupants.push(character.id);
    mainAreaOccupants.set(character.mainAreaPointId, occupants);
  }

  return characters.map((character) => {
    // 外部已经算好位置了（移动中的角色）—— 直接用。
    if (typeof character.x === "number" && typeof character.y === "number") {
      return { character, x: character.x, y: character.y };
    }

    const placement =
      (character.location === centerLocationId && character.mainAreaPointId
        ? map.getMainAreaPlacement(character.mainAreaPointId, character.id, {
            occupantIds:
              mainAreaOccupants.get(character.mainAreaPointId) ?? [character.id],
          })
        : null) ||
      map.getRandomWalkablePointInLocation(character.location, {
        preferInset: map.isPinnedLocation(character.location),
      }) ||
      { x: 400, y: 300 };

    return { character, x: placement.x, y: placement.y };
  });
}

/* ── 覆盖层构建 ────────────────────────────────────────────────── */

/**
 * 可行走区域覆盖层。
 *
 * **逐字搬自**旧 `WorldScene.buildWalkableOverlay()` ——
 * 同一行里连续的可行走格子合成一个矩形（一格一格画会多出几千个图形）。
 */
function buildWalkableItems(map: MapManager): DrawItem[] {
  const items: DrawItem[] = [];
  const tileSize = map.tileSize;

  for (let gy = 0; gy < map.gridHeight; gy++) {
    let runStart: number | null = null;
    for (let gx = 0; gx <= map.gridWidth; gx++) {
      const walkable = gx < map.gridWidth && map.isWalkable(gx, gy);
      if (walkable) {
        if (runStart == null) runStart = gx;
        continue;
      }
      if (runStart == null) continue;

      const width = (gx - runStart) * tileSize;
      const x = runStart * tileSize;
      const y = gy * tileSize;
      items.push({
        kind: "rect",
        id: `walkable:${runStart},${gy}`,
        x,
        y,
        width,
        height: tileSize,
        fill: OVERLAY_STYLE.walkable.fill,
        alpha: OVERLAY_STYLE.walkable.fillAlpha,
      });
      items.push({
        kind: "rect",
        id: `walkable-stroke:${runStart},${gy}`,
        x,
        y,
        width,
        height: tileSize,
        stroke: OVERLAY_STYLE.walkable.stroke,
        lineWidth: OVERLAY_STYLE.walkable.lineWidth,
        alpha: OVERLAY_STYLE.walkable.strokeAlpha,
      });
      runStart = null;
    }
  }

  return items;
}

/**
 * 区域框 + 区域名。
 *
 * **逐字搬自**旧 `WorldScene.buildRegionBoundsOverlay()`。
 *
 * 区域名的位置：`x + 6`，`max(6, y - 22)`（贴在框的上方，
 * 顶到画面外就压回 6）。
 */
function buildRegionBoundsItems(
  map: MapManager,
  measureText?: TextMeasurer,
): { bounds: DrawItem[]; labels: DrawItem[] } {
  const bounds: DrawItem[] = [];
  const labels: DrawItem[] = [];

  for (const location of map.getVisibleLocations()) {
    bounds.push({
      kind: "rect",
      id: `region-fill:${location.id}`,
      x: location.x,
      y: location.y,
      width: location.width,
      height: location.height,
      fill: OVERLAY_STYLE.regionBounds.fill,
      alpha: OVERLAY_STYLE.regionBounds.fillAlpha,
    });
    bounds.push({
      kind: "rect",
      id: `region-stroke:${location.id}`,
      x: location.x,
      y: location.y,
      width: location.width,
      height: location.height,
      stroke: OVERLAY_STYLE.regionBounds.stroke,
      lineWidth: OVERLAY_STYLE.regionBounds.lineWidth,
      alpha: OVERLAY_STYLE.regionBounds.strokeAlpha,
    });

    const labelX = location.x + 6;
    const labelY = Math.max(6, location.y - 22);
    const content = location.name || location.id;
    labels.push(
      buildChipLabel(
        `region-label:${location.id}`,
        labelX,
        labelY,
        content,
        LABEL_FONT,
        REGION_LABEL_COLOR,
        measureText,
      ),
    );
  }

  return { bounds, labels };
}

/**
 * 中心区域点位标记。
 *
 * **逐字搬自**旧 `WorldScene.buildMainAreaPointsOverlay()` ——
 * 外圈蓝心白点，外加一圈白描边。
 */
function buildMainAreaPointItems(map: MapManager): DrawItem[] {
  const items: DrawItem[] = [];

  for (const point of map.getMainAreaPoints()) {
    items.push({
      kind: "ellipse",
      id: `point-fill:${point.id}`,
      x: point.x,
      y: point.y,
      radiusX: OVERLAY_STYLE.mainAreaPoints.radius,
      radiusY: OVERLAY_STYLE.mainAreaPoints.radius,
      fill: OVERLAY_STYLE.mainAreaPoints.fill,
      alpha: OVERLAY_STYLE.mainAreaPoints.fillAlpha,
    });
    items.push({
      kind: "ellipse",
      id: `point-stroke:${point.id}`,
      x: point.x,
      y: point.y,
      radiusX: OVERLAY_STYLE.mainAreaPoints.radius,
      radiusY: OVERLAY_STYLE.mainAreaPoints.radius,
      stroke: OVERLAY_STYLE.mainAreaPoints.stroke,
      lineWidth: OVERLAY_STYLE.mainAreaPoints.lineWidth,
      alpha: OVERLAY_STYLE.mainAreaPoints.strokeAlpha,
    });
    items.push({
      kind: "ellipse",
      id: `point-inner:${point.id}`,
      x: point.x,
      y: point.y,
      radiusX: OVERLAY_STYLE.mainAreaPoints.innerRadius,
      radiusY: OVERLAY_STYLE.mainAreaPoints.innerRadius,
      fill: OVERLAY_STYLE.mainAreaPoints.innerFill,
      alpha: OVERLAY_STYLE.mainAreaPoints.fillAlpha,
    });
  }

  return items;
}

/**
 * 可交互物件框 + 物件名。
 *
 * **逐字搬自**旧 `WorldScene.buildInteractiveObjectsOverlay()`。
 */
function buildInteractiveObjectItems(
  map: MapManager,
  measureText?: TextMeasurer,
): { bounds: DrawItem[]; labels: DrawItem[] } {
  const bounds: DrawItem[] = [];
  const labels: DrawItem[] = [];

  for (const object of map.getInteractiveObjects()) {
    bounds.push({
      kind: "rect",
      id: `object-fill:${object.objectId}`,
      x: object.x,
      y: object.y,
      width: object.width,
      height: object.height,
      fill: OVERLAY_STYLE.interactiveObjects.fill,
      alpha: OVERLAY_STYLE.interactiveObjects.fillAlpha,
    });
    bounds.push({
      kind: "rect",
      id: `object-stroke:${object.objectId}`,
      x: object.x,
      y: object.y,
      width: object.width,
      height: object.height,
      stroke: OVERLAY_STYLE.interactiveObjects.stroke,
      lineWidth: OVERLAY_STYLE.interactiveObjects.lineWidth,
      alpha: OVERLAY_STYLE.interactiveObjects.strokeAlpha,
    });

    const labelX = object.x + 6;
    const labelY = Math.max(6, object.y - 22);
    const content = object.name || object.objectId;
    labels.push(
      buildChipLabel(
        `object-label:${object.objectId}`,
        labelX,
        labelY,
        content,
        LABEL_FONT,
        OBJECT_LABEL_COLOR,
        measureText,
      ),
    );
  }

  return { bounds, labels };
}

/**
 * 悬停高亮 + 悬停标签。
 *
 * **逐字搬自**旧 `WorldScene.setupInteractiveObjectHover()` 的 `pointerover` 分支。
 *
 * 旧实现里高亮是**圆角**矩形（`fillRoundedRect` / `strokeRoundedRect`，
 * 圆角 4）—— 契约里 `DrawRect.radius` 就是为它准备的。
 *
 * 标签是**一个容器**，里面两块：
 *
 * - 底（`fillRoundedRect`，圆角 6，黑 0.75）
 * - 字（`Text`，黑描边 2，白色，18px）
 *
 * 容器位置：
 *
 * - 水平：贴着物件中心（`object.x + width/2 - 文字宽/2`）
 * - 垂直：物件上方（`max(18, object.y - 文字高 - 12)`）
 *
 * 底比字大 `paddingX * 2` / `paddingY * 2`，
 * 所以底的四边各外扩一个内边距。
 */
function buildHoverItems(
  map: MapManager,
  hoveredObjectId: string | null | undefined,
  measureText?: TextMeasurer,
): { highlight: DrawItem[]; label: DrawItem[] } {
  const highlight: DrawItem[] = [];
  const label: DrawItem[] = [];
  if (!hoveredObjectId) return { highlight, label };

  const object = map
    .getInteractiveObjects()
    .find((candidate) => candidate.objectId === hoveredObjectId);
  if (!object) return { highlight, label };

  highlight.push({
    kind: "rect",
    id: `hover-fill:${object.objectId}`,
    x: object.x,
    y: object.y,
    width: object.width,
    height: object.height,
    fill: OVERLAY_STYLE.hover.fill,
    alpha: OVERLAY_STYLE.hover.fillAlpha,
    radius: OVERLAY_STYLE.hover.radius,
  });
  highlight.push({
    kind: "rect",
    id: `hover-stroke:${object.objectId}`,
    x: object.x,
    y: object.y,
    width: object.width,
    height: object.height,
    stroke: OVERLAY_STYLE.hover.stroke,
    lineWidth: OVERLAY_STYLE.hover.lineWidth,
    alpha: OVERLAY_STYLE.hover.strokeAlpha,
    radius: OVERLAY_STYLE.hover.radius,
  });

  const content = object.name || object.objectId;
  const measured = measureText?.(content, HOVER_LABEL_FONT);
  if (!measured) return { highlight, label };

  const paddingX = OVERLAY_STYLE.hoverLabelBg.paddingX;
  const paddingY = OVERLAY_STYLE.hoverLabelBg.paddingY;

  // 文字盒尺寸 —— 含描边（照抄 Phaser 的 `GetTextSize`）。
  const box = measureTextBox(
    measureText!,
    content,
    HOVER_LABEL_FONT,
    HOVER_LABEL_STROKE_THICKNESS,
  );

  // 标签容器位置（旧实现里的 containerX / containerY）。
  const containerX = object.x + object.width / 2 - box.width / 2;
  const containerY = Math.max(10 + paddingY, object.y - box.height - paddingY - 4);

  // 底 —— 比字大两圈内边距。
  label.push({
    kind: "rect",
    id: `hover-label-bg:${object.objectId}`,
    x: containerX - paddingX,
    y: containerY - paddingY,
    width: box.width + paddingX * 2,
    height: box.height + paddingY * 2,
    fill: OVERLAY_STYLE.hoverLabelBg.fill,
    alpha: OVERLAY_STYLE.hoverLabelBg.fillAlpha,
    radius: OVERLAY_STYLE.hoverLabelBg.radius,
  });

  // 字 —— 画在容器原点。
  label.push({
    kind: "text",
    id: `hover-label:${object.objectId}`,
    x: containerX,
    y: containerY,
    content,
    font: HOVER_LABEL_FONT,
    color: HOVER_LABEL_COLOR,
    stroke: LABEL_STROKE,
    strokeThickness: HOVER_LABEL_STROKE_THICKNESS,
    width: box.width,
    height: box.height,
  });

  return { highlight, label };
}

/* ── 角色图元 ──────────────────────────────────────────────────── */

/** 一个角色在画布上要画的东西。 */
interface CharacterDrawing {
  character: CharacterRenderState;
  x: number;
  y: number;
  hasSprite: boolean;
  footY: number;
  items: DrawItem[];
}

/**
 * 角色层的图元。
 *
 * **逐字搬自**旧 `CharacterSprite.createVisuals()`：
 *
 * - 阴影（椭圆）
 * - 身体（有贴图是精灵，没贴图是圆 + 高光弧）
 *
 * 气泡是 DOM 覆盖层，不在这里（见 `overlays`）。
 */
function buildCharacterItems(
  placements: Array<{ character: CharacterRenderState; x: number; y: number }>,
  metrics: CharacterDisplayMetrics,
  hoveredCharacterId: string | null | undefined,
): CharacterDrawing[] {
  return placements.map(({ character, x, y }) => {
    const hasSprite = !!character.spriteSource;
    const items: DrawItem[] = [];

    // 阴影
    const shadowWidth = hasSprite ? metrics.shadowWidth : metrics.circleRadius * 1.3;
    const shadowHeight = hasSprite ? metrics.shadowHeight : metrics.circleRadius * 0.55;
    const shadowOffsetY = hasSprite
      ? metrics.shadowOffsetY
      : metrics.circleRadius * 0.65;
    items.push({
      kind: "ellipse",
      id: `character-shadow:${character.id}`,
      x,
      y: y + shadowOffsetY,
      radiusX: shadowWidth / 2,
      radiusY: shadowHeight / 2,
      fill: "#000000",
      alpha: 0.4,
    });

    if (hasSprite) {
      const facing = character.facing ?? "down";
      const { frame, flipX } = getIdleFrame(facing);
      const drawing: DrawItem = {
        kind: "sprite",
        id: `character:${character.id}`,
        x,
        y,
        // 贴图的锚点 —— 逐字搬自旧 `CharacterSprite.createSpriteBody()`
        // 的 `setOrigin(0.5, 0.85)`。
        //
        // 0.85 决定「脚底在哪、头顶在哪」，也就决定了名牌挂哪儿
        // （见 `getHeadWorldOffset()`）。写错角色会浮起来或陷进地里。
        originX: 0.5,
        originY: 0.85,
        source: character.spriteSource!,
        frame,
        width: metrics.spriteWidth,
        height: metrics.spriteHeight,
        flipX,
      };
      // 悬停时贴图染成淡紫色（旧实现：setTint(0xddddff)）。
      if (hoveredCharacterId === character.id) {
        (drawing as { tint?: string }).tint = "#ddddff";
      }
      items.push(drawing);
    } else {
      const colorIndex = character.colorIndex ?? 0;
      const circle: DrawItem = {
        kind: "ellipse",
        id: `character:${character.id}`,
        x,
        y,
        radiusX: metrics.circleRadius,
        radiusY: metrics.circleRadius,
        fill: toCssColor(getCharacterColor(colorIndex)),
        stroke: hoveredCharacterId === character.id ? "#ffff00" : "#ffffff",
        lineWidth: metrics.circleStrokeWidth,
      };
      items.push(circle);

      // 高光弧（旧实现：add.arc(cx, cy, r, 0, 360, false, 0xffffff, 0.35)）。
      items.push({
        kind: "ellipse",
        id: `character-highlight:${character.id}`,
        x: x + metrics.circleHighlightOffsetX,
        y: y + metrics.circleHighlightOffsetY,
        radiusX: metrics.circleHighlightRadius,
        radiusY: metrics.circleHighlightRadius,
        fill: "#ffffff",
        alpha: 0.35,
        arcStart: 0,
        arcEnd: 360,
      });
    }

    return {
      character,
      x,
      y,
      hasSprite,
      footY: getSortFootY(metrics, hasSprite, y),
      items,
    };
  });
}

/**
 * 站桩的帧号和水平翻转。
 *
 * **逐字搬自**旧 `CharacterSprite.setIdleFrame()`。
 *
 * 帧 18 = 正面，19 = 背面，20 = 侧面；
 * 朝右用同一张侧面帧但水平翻转。
 */
export function getIdleFrame(facing: FacingDirection): { frame: number; flipX: boolean } {
  switch (facing) {
    case "up":
      return { frame: 19, flipX: false };
    case "left":
      return { frame: 20, flipX: false };
    case "right":
      return { frame: 20, flipX: true };
    case "down":
    default:
      return { frame: 18, flipX: false };
  }
}

/* ── 覆盖层（DOM）──────────────────────────────────────────────── */

/**
 * 角色名牌和对话气泡 —— **屏幕坐标**。
 *
 * ## 为什么不在 `layers` 里
 *
 * 它们**不是 canvas 图元** —— 旧实现里是 `HTMLDivElement` + CSS。
 * 契约把它们单列成 `OverlayItem`，渲染实现可以继续用 DOM 画，
 * 也可以改成 canvas 画（那时这层就并进 `layers`）。
 *
 * ## 位置跟旧实现逐字一致
 *
 * 旧实现（`CharacterSprite.updateDomLabelPosition()`）：
 *
 * ```ts
 * const screenX = (this.x - worldView.x) * camera.zoom + camera.x;
 * const screenY = (this.y - worldView.y) * camera.zoom + camera.y;
 * const headScreenY = screenY - this.getHeadWorldOffset() * camera.zoom;
 * const bubbleScreenY = (this.y + this.getBubbleAnchorOffsetY() - worldView.y) * camera.zoom + camera.y;
 * ```
 *
 * 这里用契约的 `worldToScreen()` —— 它用 `scrollX` 代替 `worldView.x`，
 * 差别只在「谁来取整」（见 `render-model.ts` 的说明）。
 *
 * 旧实现最后把坐标**取整**（`Math.round`）再写进 style ——
 * 这里也取整，数值才能跟旧实现逐点相等。
 */
/**
 * 屏幕坐标是否在视口内（留 120px 余量）。
 *
 * **逐字搬自**旧 `CharacterSprite.updateDomLabelPosition()`：
 *
 * ```
 * visible =
 *   screenX >= -120 && screenX <= camera.width  + 120 &&
 *   screenY >= -120 && screenY <= camera.height + 120
 * ```
 *
 * 之所以给 120px 余量：名牌和气泡有**尺寸**，
 * 角色本体刚出屏时它的名牌还看得见 —— 余量就是那个尺寸。
 */
function isWithinViewport(
  camera: CameraState,
  screenX: number,
  screenY: number,
): boolean {
  return (
    screenX >= -120 &&
    screenX <= camera.viewportWidth + 120 &&
    screenY >= -120 &&
    screenY <= camera.viewportHeight + 120
  );
}

function buildOverlayItems(
  camera: CameraState,
  characters: CharacterRenderState[],
  placements: Array<{ character: CharacterRenderState; x: number; y: number }>,
  bubbles: DialogueBubbleState[],
  metrics: CharacterDisplayMetrics,
): OverlayItem[] {
  const overlays: OverlayItem[] = [];
  const placementById = new Map(placements.map((p) => [p.character.id, p]));
  const bubbleByCharacter = new Map<string, DialogueBubbleState>();
  for (const bubble of bubbles) {
    bubbleByCharacter.set(bubble.characterId, bubble);
  }

  for (const character of characters) {
    const placement = placementById.get(character.id);
    if (!placement) continue;

    const hasSprite = !!character.spriteSource;
    const screen = worldToScreen(camera, placement.x, placement.y);
    const headScreenY =
      screen.y - getHeadWorldOffset(metrics, hasSprite) * camera.zoom;

    overlays.push({
      kind: "character-label",
      characterId: character.id,
      x: Math.round(screen.x),
      y: Math.round(headScreenY),
      content: character.name,
      actionIcon: actionToEmoji(character.action ?? null) || undefined,
      actionLabel: character.actionLabel ?? undefined,
      zoom: camera.zoom,
      visible: isWithinViewport(camera, screen.x, screen.y),
    });

    const bubble = bubbleByCharacter.get(character.id);
    if (!bubble) continue;

    const anchorX = bubble.x ?? placement.x;
    const anchorY = bubble.y ?? placement.y + getBubbleAnchorOffsetY(metrics, hasSprite);
    const bubbleScreen = worldToScreen(camera, anchorX, anchorY);
    overlays.push({
      kind: "dialogue-bubble",
      characterId: character.id,
      x: Math.round(bubbleScreen.x),
      y: Math.round(bubbleScreen.y),
      content: bubble.content,
      innerMonologue: bubble.innerMonologue,
      zoom: camera.zoom,
      // 旧实现里气泡的显示跟随**同一个** `visible` 变量
      // （`updateDomLabelPosition()` 里一起算的），所以这里用名牌那份。
      visible: isWithinViewport(camera, screen.x, screen.y),
    });
  }

  return overlays;
}

/* ── 主入口 ────────────────────────────────────────────────────── */

/**
 * 构建一个渲染场景。
 *
 * **纯函数** —— 同样的输入产出同样的输出（除了
 * `MapManager.getRandomWalkablePointInLocation()` 内部的随机，
 * 那部分旧实现也是随机的）。
 *
 * 不碰 canvas / Phaser / DOM / React。
 */
export function buildRenderScene(input: SceneBuilderInput): RenderScene {
  const {
    map,
    camera,
    background,
    characters,
    bubbles = [],
    overlays = {},
    hoveredObjectId = null,
    hoveredCharacterId = null,
    measureText,
  } = input;

  const metrics =
    input.displayMetrics ??
    createCharacterDisplayMetrics(camera.mapWidth, camera.mapHeight);

  const placements = resolveCharacterPlacements(map, characters);
  const drawings = buildCharacterItems(placements, metrics, hoveredCharacterId);

  // 角色按脚底 y 排序 —— 站得靠下的盖住站得靠上的。
  //
  // 旧实现是对 `entityLayer.list` 排序（`Array.prototype.sort` 是稳定的），
  // 这里用同样的稳定排序，顺序一致。
  const sortedDrawings = [...drawings].sort((a, b) => a.footY - b.footY);

  const layers: RenderLayer[] = [];
  const pushLayer = (id: string, depth: number, items: DrawItem[]) => {
    if (items.length === 0) return;
    layers.push({ id, depth, items });
  };

  if (overlays.walkable) {
    pushLayer(
      SCENE_LAYER_IDS.walkable,
      SCENE_LAYER_DEPTHS.walkable,
      buildWalkableItems(map),
    );
  }

  pushLayer(
    SCENE_LAYER_IDS.characters,
    SCENE_LAYER_DEPTHS.characters,
    sortedDrawings.flatMap((drawing) => drawing.items),
  );

  const hover = buildHoverItems(map, hoveredObjectId, measureText);
  pushLayer(
    SCENE_LAYER_IDS.hoverHighlight,
    SCENE_LAYER_DEPTHS.hoverHighlight,
    hover.highlight,
  );
  pushLayer(SCENE_LAYER_IDS.hoverLabel, SCENE_LAYER_DEPTHS.hoverLabel, hover.label);

  const labelItems: DrawItem[] = [];

  if (overlays.regionBounds) {
    const region = buildRegionBoundsItems(map, measureText);
    pushLayer(
      SCENE_LAYER_IDS.regionBounds,
      SCENE_LAYER_DEPTHS.regionBounds,
      region.bounds,
    );
    labelItems.push(...region.labels);
  }

  if (overlays.mainAreaPoints) {
    pushLayer(
      SCENE_LAYER_IDS.mainAreaPoints,
      SCENE_LAYER_DEPTHS.mainAreaPoints,
      buildMainAreaPointItems(map),
    );
  }

  if (overlays.interactiveObjects) {
    const objects = buildInteractiveObjectItems(map, measureText);
    pushLayer(
      SCENE_LAYER_IDS.interactiveObjects,
      SCENE_LAYER_DEPTHS.interactiveObjects,
      objects.bounds,
    );
    labelItems.push(...objects.labels);
  }

  pushLayer(SCENE_LAYER_IDS.labels, SCENE_LAYER_DEPTHS.labels, labelItems);

  // 图层按 depth 升序 —— 后面的盖前面的。
  layers.sort((a, b) => a.depth - b.depth);

  return {
    background,
    camera,
    layers,
    overlays: buildOverlayItems(
      camera,
      characters,
      placements,
      bubbles,
      metrics,
    ),
  };
}

/**
 * 场景里某个矩形的辅助函数 —— 给渲染实现做命中测试用。
 *
 * 命中测试是**屏幕坐标**的事（见 `SceneRenderer.hitTest`），
 * 这里给一个世界坐标 → 命中 id 的查法。
 */
export function hitTestScene(
  scene: RenderScene,
  worldX: number,
  worldY: number,
): string | null {
  // 从最上面的一层往下找 —— 后面的盖前面的，所以上面的先命中。
  const layers = [...scene.layers].sort((a, b) => b.depth - a.depth);
  for (const layer of layers) {
    for (const item of layer.items) {
      if (item.kind !== "rect") continue;
      const rect = item as DrawRect;
      if (
        worldX >= rect.x &&
        worldX <= rect.x + rect.width &&
        worldY >= rect.y &&
        worldY <= rect.y + rect.height
      ) {
        return rect.id;
      }
    }
  }
  return null;
}
