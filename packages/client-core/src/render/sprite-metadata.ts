/**
 * 角色贴图集的**格子尺寸**从哪来。
 *
 * ## 为什么单独一个文件
 *
 * 贴图集是 **6 列 × 5 行** 的网格，但**格子多大不是固定的**：
 *
 * | 贴图集 | 图片尺寸 | 真格子 |
 * |---|---|---|
 * | 老的（`library/`） | 1024×1024 | **170×204** |
 * | 新的（`output/`） | 1048×1048 | **174×209** |
 *
 * 生成器写图的时候，格子是 `floor(图宽/6) × floor(图高/5)`
 * （见 `generators/character/src/utils/sprite-meta.mjs`）——
 * **图多大，格子就多大**。
 *
 * 改造前 client 把格子**硬编码**成 `170×204`
 * （`client/src/config/game-config.ts`）。对老图正好，
 * 对新图就**错位**了 —— 而且是**累加**的错位：
 *
 * ```
 * 真内容 y 范围      client 的窗口起点     漂移
 *  27 ..  193   行0   0                      -27
 * 231 ..  401   行1   204                    -27
 * 444 ..  617   行2   408                    -36
 * 664 ..  834   行3   612                    -52
 * ```
 *
 * 越往下的行偏得越多。站桩帧（帧 18 = 行3列0）的窗口
 * `y=612..816` 截到的是：
 *
 * - **顶部**那 15 行 —— 上一行 walk-up 的**脚**
 * - **底部** —— 角色的**脚被切掉了**（真内容到 836 才结束）
 *
 * 画出来就是「**脚在头上**」。
 *
 * ## 修法
 *
 * 生成器**已经把真值写进 `metadata.json`** 了
 * （`frameWidth` / `frameHeight` / `columns` / `rows`）——
 * 只是从来没人读。
 *
 * 所以：**先读 metadata，读不到再按图算，最后才用硬编码兜底**。
 *
 * ## 优先级
 *
 * ```
 * 显式指定  >  metadata.json  >  按图算（floor(宽/列) × floor(高/行)）  >  170×204
 * ```
 *
 * 「按图算」跟生成器自己的公式**一模一样**
 * （`buildMetadata` 就是这么算的），所以它不是「猜」——
 * 只是「metadata 读不到时的等价替代」。
 *
 * 硬编码的 `170×204` 只在**图和 metadata 都没有**时才用 ——
 * 那时候至少还有个已知能用的值。
 */

/** 贴图集的一格多大。 */
export interface SpriteFrameSize {
  /** 一格的宽（像素）。 */
  frameWidth: number;
  /** 一格的高（像素）。 */
  frameHeight: number;
}

/**
 * `metadata.json` 里的字段（只挑我们要的）。
 *
 * 生成器写出来的完整内容还有名字、描述、动画定义等等 ——
 * 这里只关心格子尺寸和网格形状。
 */
export interface CharacterSpriteMetadata extends SpriteFrameSize {
  /** 网格几列。 */
  columns: number;
  /** 网格几行。 */
  rows: number;
}

/**
 * 兜底格子尺寸 —— 老贴图集（1024×1024）的真值。
 *
 * **不是**「随便一个数」—— 是**老图确实就是这个值**。
 * 新图走 metadata / 按图算这两条路，走不到这里。
 */
export const DEFAULT_SPRITE_FRAME_WIDTH = 170;
export const DEFAULT_SPRITE_FRAME_HEIGHT = 204;

/** 贴图集的网格形状 —— 6 列 × 5 行（提示词里定的，见 `prompts/character/generate-sprite.md`）。 */
export const DEFAULT_SPRITE_COLUMNS = 6;
export const DEFAULT_SPRITE_ROWS = 5;

/**
 * 角色 `metadata.json` 的地址。
 *
 * server 把角色目录挂在 `/assets/characters` 下
 * （`server/src/index.ts`），所以地址是拼出来的。
 */
export function characterMetadataUrl(characterId: string): string {
  return `/assets/characters/${characterId}/metadata.json`;
}

/**
 * 解析 `metadata.json` 的内容。
 *
 * ## 为什么逐个字段验
 *
 * 这个文件是**外部产物**（生成器写的，可能来自旧版本、可能被人手改过）。
 * 字段缺失或类型不对时**不能炸** —— 回落到别的途径就好。
 *
 * 所以：能用的字段就取，不能用的当没有，返回 `null` 表示「这份 metadata 没用」。
 */
export function parseCharacterSpriteMetadata(
  raw: unknown,
): CharacterSpriteMetadata | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;

  const frameWidth = Number(record.frameWidth);
  const frameHeight = Number(record.frameHeight);
  if (!Number.isFinite(frameWidth) || frameWidth <= 0) return null;
  if (!Number.isFinite(frameHeight) || frameHeight <= 0) return null;

  const columns = Number(record.columns);
  const rows = Number(record.rows);

  return {
    frameWidth: Math.floor(frameWidth),
    frameHeight: Math.floor(frameHeight),
    columns: Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : DEFAULT_SPRITE_COLUMNS,
    rows: Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : DEFAULT_SPRITE_ROWS,
  };
}

/**
 * 按图片尺寸算格子大小。
 *
 * **逐字复刻生成器的公式**（`buildMetadata`）：
 * `frameWidth = floor(图片宽 / 列数)`。
 *
 * 这不是「猜网格」—— 网格形状（6×5）是提示词里定死的，
 * 生成器也是按这个切的。
 */
export function deriveSpriteFrameSize(
  imageWidth: number,
  imageHeight: number,
  columns: number = DEFAULT_SPRITE_COLUMNS,
  rows: number = DEFAULT_SPRITE_ROWS,
): SpriteFrameSize {
  return {
    frameWidth: Math.floor(imageWidth / columns),
    frameHeight: Math.floor(imageHeight / rows),
  };
}

/** 解析格子尺寸时的输入 —— 每一条都**可能没有**。 */
export interface SpriteFrameSizeSources {
  /** 显式指定的格子大小（最优先）。 */
  explicit?: SpriteFrameSize | null;
  /** `metadata.json` 里读到的。 */
  metadata?: CharacterSpriteMetadata | null;
  /** 图片本身的尺寸（用来「按图算」）。 */
  imageWidth?: number;
  imageHeight?: number;
  /** metadata 里的网格形状（没有就用默认的 6×5）。 */
  columns?: number;
  rows?: number;
}

/**
 * 定下格子大小 —— 按优先级来。
 *
 * ```
 * 显式指定  >  metadata.json  >  按图算  >  170×204
 * ```
 *
 * 每一步都可能是「没有」—— 所以逐个往下试，
 * **任何一步有值就是那一步说了算**。
 */
export function resolveSpriteFrameSize(
  sources: SpriteFrameSizeSources,
): SpriteFrameSize {
  const explicit = sources.explicit;
  if (explicit && explicit.frameWidth > 0 && explicit.frameHeight > 0) {
    return { frameWidth: explicit.frameWidth, frameHeight: explicit.frameHeight };
  }

  const metadata = sources.metadata;
  if (metadata && metadata.frameWidth > 0 && metadata.frameHeight > 0) {
    return { frameWidth: metadata.frameWidth, frameHeight: metadata.frameHeight };
  }

  const { imageWidth, imageHeight } = sources;
  if (
    typeof imageWidth === "number" &&
    typeof imageHeight === "number" &&
    imageWidth > 0 &&
    imageHeight > 0
  ) {
    const derived = deriveSpriteFrameSize(
      imageWidth,
      imageHeight,
      sources.columns ?? DEFAULT_SPRITE_COLUMNS,
      sources.rows ?? DEFAULT_SPRITE_ROWS,
    );
    if (derived.frameWidth > 0 && derived.frameHeight > 0) {
      return derived;
    }
  }

  return {
    frameWidth: DEFAULT_SPRITE_FRAME_WIDTH,
    frameHeight: DEFAULT_SPRITE_FRAME_HEIGHT,
  };
}

/**
 * 读角色 `metadata.json` 的加载器。
 *
 * 抽象出来是为了**能测**（单测注入假的）和**能换**
 * （Node 冒烟脚本可以用本地文件）。
 */
export type SpriteMetadataLoader = (
  characterId: string,
) => Promise<CharacterSpriteMetadata | null>;

/**
 * 默认加载器 —— 走浏览器的 `fetch`。
 *
 * **失败不抛，返回 `null`** —— metadata 读不到只是「少一条信息」，
 * 不该让整个渲染挂掉（后面还有「按图算」和硬编码兜底）。
 */
export const defaultSpriteMetadataLoader: SpriteMetadataLoader = async (
  characterId: string,
) => {
  if (typeof fetch === "undefined") return null;
  try {
    const response = await fetch(characterMetadataUrl(characterId));
    if (!response.ok) return null;
    return parseCharacterSpriteMetadata(await response.json());
  } catch {
    return null;
  }
};

/**
 * 「拿到图片多大」—— 用来在 metadata 缺失时**按图算**。
 *
 * 抽象出来是为了**能测**（单测注入假的）和**能换**
 * （Node 冒烟脚本读本地文件，浏览器读 `<img>`）。
 */
export type SpriteImageSizeLoader = (
  characterId: string,
) => Promise<{ width: number; height: number } | null>;

/** 查角色格子大小时要用的加载器。 */
export interface CharacterFrameSizeLoaders {
  /** 读 `metadata.json`。 */
  metadata?: SpriteMetadataLoader;
  /** 拿图片尺寸（按图算时用）。 */
  imageSize?: SpriteImageSizeLoader;
}

/**
 * 查一个角色的格子大小 —— **把两条异步路径都走一遍**。
 *
 * 优先级跟 `resolveSpriteFrameSize` 一致：
 * 显式 > metadata > 按图算 > 兜底。
 *
 * ## 为什么要有这个包装
 *
 * `resolveSpriteFrameSize` 是**纯函数**（输入齐了才算），
 * 但实际用的时候两条信息都是**异步**的：
 *
 * - metadata 要 `fetch`
 * - 图片尺寸要么 `fetch` 要么等 `<img>` 加载
 *
 * 这个函数把那两条异步路径接上，纯函数那层保持可测。
 */
export async function loadCharacterSpriteFrameSize(
  characterId: string,
  loaders: CharacterFrameSizeLoaders = {},
): Promise<SpriteFrameSize> {
  const metadataLoader = loaders.metadata ?? defaultSpriteMetadataLoader;

  /**
   * metadata 读不到**不算错** —— 后面还有「按图算」和兜底值两条路。
   *
   * 所以这里把异常也吞掉：默认加载器自己已经吞了（返回 `null`），
   * 但**注入进来的**加载器可能抛 —— 那一层不该让整个渲染挂掉。
   */
  let metadata: CharacterSpriteMetadata | null = null;
  try {
    metadata = await metadataLoader(characterId);
  } catch {
    metadata = null;
  }

  // metadata 有了就**不用**再拿图片尺寸了。
  if (metadata) {
    return resolveSpriteFrameSize({ metadata });
  }

  const imageSizeLoader = loaders.imageSize;
  if (imageSizeLoader) {
    let size: { width: number; height: number } | null = null;
    try {
      size = await imageSizeLoader(characterId);
    } catch {
      size = null;
    }
    if (size) {
      // ⚠ 这里 `metadata` 一定是 `null`（上面已经 return 掉了）——
      // 所以网格形状只能用默认值 6×5。
      //
      // 网格形状是提示词里定死的（见 `prompts/character/generate-sprite.md`），
      // 生成器也是按 6×5 切的，所以这个默认值不是「猜」。
      return resolveSpriteFrameSize({
        imageWidth: size.width,
        imageHeight: size.height,
      });
    }
  }

  return resolveSpriteFrameSize({});
}
