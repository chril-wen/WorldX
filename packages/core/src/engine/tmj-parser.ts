/**
 * TMJ 解析 —— 全仓唯一的地图解析实现。
 *
 * ## 为什么在 core 里，不在 client-core 里
 *
 * 因为**core 本身就在读 TMJ**：
 *
 * - `engine/world-manager.ts` 的 `rebuildMainAreaPointAdjacencyFromTmj()`
 *   读 collision 层，重建主区域点位的邻接关系
 * - `engine/world-manager.ts` 的 `inferWorldSizeFromWorldDir()` 读地图尺寸
 *
 * 解析器放 client-core 的话，core 就得依赖 client-core，
 * 而 client-core 又依赖 core（为了 `MainAreaPointConfig`）—— **成环**。
 *
 * 放 core 里则依赖方向是单向的：core ← client-core。
 *
 * ## 为什么要有这一份
 *
 * 改造前，TMJ（`06-final.tmj`）的解析在全仓有**四份独立实现**：
 *
 * | 位置 | 解析什么 | 语言 |
 * |---|---|---|
 * | `client/src/systems/MapManager.ts` | collision / regions / interactive_objects | TS |
 * | `packages/core/src/engine/world-manager.ts` | 只读 collision | TS |
 * | `orchestrator/src/config-generator.mjs` | regions / interactive_objects / collision | JS |
 * | `orchestrator/src/expand-map.mjs` | 同上（还要**改** TMJ） | JS |
 *
 * 它们之间的契约只是「文件名 + 层名」两个字符串 —— 没有任何类型、
 * 没有任何校验。core 的 `world-manager.ts:818` 和 client 的 `MapManager.ts:84`
 * **读的是同一份文件里的同一层（collision），却各自解析**。
 *
 * 这跟阶段 4 处理过的 `normalizeLocations` 是同一类问题：
 * 两份逐字重复、连错误都一样，而且两边都没有测试。
 *
 * ## 这一份负责什么、不负责什么
 *
 * **负责**：找到层、读出结构、把 properties 摊平成普通对象。
 *
 * **不负责**：各调用方**对缺失字段的不同兜底**。
 * 这是刻意的 —— 现状里各方的兜底规则**确实不同**：
 *
 * - client 的 `MapManager`：区域没有 `id` 属性就**跳过**
 * - orchestrator 的 `expand-map`：区域没有 `id` 就**退回用 name 当 id**
 *
 * 这两个行为不一样，而且是**有意义的**（client 不该拿名字当 id，
 * 生成期则要尽量不丢数据）。所以解析层保留 `id: null`，
 * 由调用方各自决定 —— **改兜底规则要改调用方，不改这里**。
 */

/** 像素坐标 —— 解析器内部的最小表示，不进 contracts */
interface PixelPoint {
  x: number;
  y: number;
}

/** Tiled 的一层 —— 这里只列我们真正会读的字段。 */
export interface TmjLayer {
  name?: string;
  type?: string;
  data?: unknown;
  objects?: unknown;
  image?: string;
  imagewidth?: number;
  imageheight?: number;
}

/**
 * 按名字找一层。
 *
 * ## 为什么需要这个
 *
 * orchestrator（`.mjs`）里到处是 `tmj.layers.find((l) => l.name === "regions")`
 * —— 「层名」这个字符串散落在全仓各处，没有任何类型保证它们一致。
 *
 * 这里把查找收敛到一处。**返回原始 layer 对象**，不是解析结果 ——
 * 因为 orchestrator 的下游（`main-area-points.mjs` 等）要的是原始形状。
 */
export function findTmjLayer(tmj: unknown, name: string, type?: string): TmjLayer | null {
  const source = (tmj && typeof tmj === "object" ? tmj : {}) as { layers?: unknown };
  const layers: TmjLayer[] = Array.isArray(source.layers) ? (source.layers as TmjLayer[]) : [];
  for (const layer of layers) {
    if (layer?.name !== name) continue;
    if (type && layer.type !== type) continue;
    return layer;
  }
  return null;
}

/** Tiled 的一个对象（区域或可交互物件） */
export interface TmjObject {
  /** properties 里的 `id` —— 没有就是 null（**不退回用 name**） */
  id: string | null;
  /** properties 里的 `objectId` —— 没有就是 null */
  objectId: string | null;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 摊平后的 properties —— 键是属性名，值是属性值 */
  properties: Record<string, unknown>;
}

/** TMJ 里的背景图层 */
export interface TmjBackground {
  image: string;
  width: number;
  height: number;
}

/** 解析结果 */
export interface ParsedTmj {
  /** 网格宽（格） */
  width: number;
  /** 网格高（格） */
  height: number;
  /**
   * 每格边长（像素）。
   *
   * TMJ 没写 `tilewidth` 时用 `DEFAULT_TILE_SIZE`。
   */
  tileSize: number;
  /**
   * TMJ **显式写了** `tilewidth` 吗？
   *
   * 为什么需要这个标志：各调用方对「tilewidth 缺失」的处理**不一样** ——
   *
   * - client 的 `MapManager`：用默认值 32，继续
   * - core 的 `world-manager.ts`：**放弃**重建点位邻接（保守，怕算错）
   *
   * 解析层不能替它们选一边 —— 所以把事实暴露出来，让调用方自己判断。
   */
  hasTileWidth: boolean;
  /**
   * collision 网格 —— `0` = 可走，非 0 = 阻挡。
   *
   * **null 表示 TMJ 里没有 collision 层** —— 调用方要自己决定怎么办
   * （client 保留上一次的网格，core 直接放弃重建）。
   */
  collisionGrid: number[][] | null;
  /** collision 层的原始扁平数组 —— core 的点位邻接算法要这个形状 */
  collisionData: number[] | null;
  /** regions 图层里的区域（**未过滤**） */
  regions: TmjObject[];
  /** interactive_objects 图层里的物件（**未过滤**） */
  interactiveObjects: TmjObject[];
  /** background 图层 —— 没有就是 null */
  background: TmjBackground | null;
  /** 地图的像素尺寸 */
  pixelWidth: number;
  pixelHeight: number;
}

/** 默认的每格边长 —— TMJ 没写 `tilewidth` 时用这个 */
export const DEFAULT_TILE_SIZE = 32;

/**
 * 把 properties 数组摊平成普通对象。
 *
 * Tiled 的 properties 是 `[{name, type, value}]`。
 * 重复的属性名**后者覆盖前者**（跟 Tiled 自己的行为一致）。
 */
function flattenProperties(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const prop = entry as { name?: unknown; value?: unknown };
    if (typeof prop.name !== "string") continue;
    out[prop.name] = prop.value;
  }
  return out;
}

/** 读一个 Tiled 对象的 id —— 只认 `id` 属性，不退回用 name */
function readId(properties: Record<string, unknown>): string | null {
  const id = properties.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** 读一个 Tiled 对象的 objectId —— 只认 `objectId` 属性 */
function readObjectId(properties: Record<string, unknown>): string | null {
  const id = properties.objectId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** 把 objectgroup 里的一批对象读成 TmjObject */
function parseObjects(layer: TmjLayer, kind: "region" | "object"): TmjObject[] {
  if (!Array.isArray(layer.objects)) return [];

  const parsed: TmjObject[] = [];
  for (const raw of layer.objects) {
    if (!raw || typeof raw !== "object") continue;
    const obj = raw as {
      name?: unknown;
      x?: unknown;
      y?: unknown;
      width?: unknown;
      height?: unknown;
      properties?: unknown;
    };
    const properties = flattenProperties(obj.properties);
    parsed.push({
      id: kind === "region" ? readId(properties) : null,
      objectId: kind === "object" ? readObjectId(properties) : null,
      name: typeof obj.name === "string" ? obj.name : "",
      x: Number(obj.x) || 0,
      y: Number(obj.y) || 0,
      width: Number(obj.width) || 0,
      height: Number(obj.height) || 0,
      properties,
    });
  }
  return parsed;
}

/**
 * 解析一份 TMJ。
 *
 * **纯函数** —— 不读文件、不改输入、不打日志。
 * 读文件是调用方的事（client 从 vite 的 cache 拿，core / orchestrator 从磁盘读）。
 */
export function parseTmj(tmj: unknown): ParsedTmj {
  const source = (tmj && typeof tmj === "object" ? tmj : {}) as {
    width?: unknown;
    height?: unknown;
    tilewidth?: unknown;
    tileheight?: unknown;
    layers?: unknown;
  };

  const width = Number(source.width) || 0;
  const height = Number(source.height) || 0;
  const hasTileWidth = Number.isFinite(Number(source.tilewidth)) && Number(source.tilewidth) > 0;
  const tileSize = hasTileWidth ? Number(source.tilewidth) : DEFAULT_TILE_SIZE;
  const layers: TmjLayer[] = Array.isArray(source.layers)
    ? (source.layers as TmjLayer[])
    : [];

  let collisionGrid: number[][] | null = null;
  let collisionData: number[] | null = null;
  let regions: TmjObject[] = [];
  let interactiveObjects: TmjObject[] = [];
  let background: TmjBackground | null = null;

  for (const layer of layers) {
    if (layer.type === "tilelayer" && layer.name === "collision") {
      const data = Array.isArray(layer.data) ? (layer.data as number[]) : [];
      const grid: number[][] = [];
      for (let y = 0; y < height; y++) {
        const row: number[] = [];
        for (let x = 0; x < width; x++) {
          // 0 = 可走，非 0 = 阻挡
          row.push(data[y * width + x] === 0 ? 0 : 1);
        }
        grid.push(row);
      }
      collisionGrid = grid;
      collisionData = data;
    } else if (layer.type === "objectgroup" && layer.name === "regions") {
      regions = parseObjects(layer, "region");
    } else if (layer.type === "objectgroup" && layer.name === "interactive_objects") {
      interactiveObjects = parseObjects(layer, "object");
    } else if (layer.type === "imagelayer" && layer.name === "background") {
      background = {
        image: typeof layer.image === "string" ? layer.image : "",
        width: Number(layer.imagewidth) || 0,
        height: Number(layer.imageheight) || 0,
      };
    }
  }

  return {
    width,
    height,
    tileSize,
    hasTileWidth,
    collisionGrid,
    collisionData,
    regions,
    interactiveObjects,
    background,
    pixelWidth: width * tileSize,
    pixelHeight: height * tileSize,
  };
}

/**
 * 从已解析的地图里取出「区域矩形」—— 丢弃没有 id 的。
 *
 * client 的 `MapManager` 一直用这个规则（没有 id 的区域直接跳过）。
 * orchestrator 的规则不同（退回用 name），所以它不用这个函数。
 */
export function toLocationRects(
  regions: TmjObject[],
): Array<{ id: string; name: string; x: number; y: number; width: number; height: number }> {
  const rects = [];
  for (const region of regions) {
    if (!region.id) continue;
    rects.push({
      id: region.id,
      name: region.name || region.id,
      x: region.x,
      y: region.y,
      width: region.width,
      height: region.height,
    });
  }
  return rects;
}

/**
 * 从已解析的地图里取出「可交互物件」—— 丢弃没有 objectId 的。
 */
export function toInteractiveObjects(
  objects: TmjObject[],
): Array<{ objectId: string; name: string; x: number; y: number; width: number; height: number }> {
  const result = [];
  for (const obj of objects) {
    if (!obj.objectId) continue;
    result.push({
      objectId: obj.objectId,
      name: obj.name || obj.objectId,
      x: obj.x,
      y: obj.y,
      width: obj.width,
      height: obj.height,
    });
  }
  return result;
}

/** 把像素坐标换算成网格坐标 */
export function pixelToGrid(px: number, py: number, tileSize: number): { gx: number; gy: number } {
  return {
    gx: Math.floor(px / tileSize),
    gy: Math.floor(py / tileSize),
  };
}

/** 把网格坐标换算成像素坐标（格子中心） */
export function gridToPixel(gx: number, gy: number, tileSize: number): PixelPoint {
  return {
    x: gx * tileSize + tileSize / 2,
    y: gy * tileSize + tileSize / 2,
  };
}
