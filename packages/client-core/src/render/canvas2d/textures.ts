/**
 * 贴图 —— Canvas 2D 渲染器怎么把「source 字符串」变成能画的东西。
 *
 * ## 为什么需要这一层
 *
 * 契约里的 `source` 是个**字符串**，含义「由渲染实现决定」（见 `render-model.ts`）：
 *
 * - `DrawImage.source` —— Canvas 2D 当成 URL
 * - `DrawSprite.source` —— 角色贴图的**纹理 key**（角色 id）
 *
 * 但真正要画，还得知道：图片在哪、多大、贴图集怎么切帧。
 *
 * ## 贴图集的帧序 —— 照抄 Phaser
 *
 * 角色的贴图是一张 **spritesheet**（6 列 × 5 行，每帧 170×204）。
 * Phaser 的帧编号是**行优先**的：从左上角开始，一行排满再换行。
 *
 * Phaser 的解析器（`textures/parsers/SpriteSheet.js`）就是这么算的：
 *
 * ```
 * 每行帧数 = floor(图宽 / 帧宽)
 * 总帧数   = 每行帧数 × floor(图高 / 帧高)
 * 第 i 帧  = 第 (i % 每行帧数) 列、第 floor(i / 每行帧数) 行
 * ```
 *
 * **必须逐字复刻** —— 帧号差一个，角色就换了张脸（帧 18 是正面，
 * 帧 19 是背面）。旧实现里「站桩帧」是 18/19/20，写错就是角色一直背对镜头。
 */

/** 贴图里的一帧（源图上的一个矩形）。 */
export interface TextureFrame {
  /** 源图上的左上角。 */
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 一个能画到 canvas 上的贴图。
 *
 * `frames` 有值 = 这是张贴图集（`DrawSprite.frame` 按它取帧）；
 * 没有值 = 一整张图（`DrawImage`、地图底图）。
 */
export interface Texture {
  /** 已解码的图片。 */
  image: CanvasImageSource;
  /** 图片的原始宽（像素）。 */
  width: number;
  /** 图片的原始高（像素）。 */
  height: number;
  /** 贴图集的帧表（没有就是单图）。 */
  frames?: TextureFrame[];
}

/**
 * 一张贴图的**来源描述** —— 「去哪儿拿、怎么切」。
 *
 * 渲染器拿到它就去加载（URL → 图片），加载好再画。
 */
export interface TextureSpec {
  /** 图片地址。 */
  url: string;
  /** 贴图集的帧宽（给了就是贴图集）。 */
  frameWidth?: number;
  /** 贴图集的帧高（默认跟帧宽一样）。 */
  frameHeight?: number;
}

/**
 * 按 Phaser 的规则切帧。
 *
 * **逐字复刻** `Phaser.Textures.Parsers.SpriteSheet` ——
 * 包括「贴图边缘的帧会被裁窄」这个细节。
 */
export function buildSpriteSheetFrames(
  imageWidth: number,
  imageHeight: number,
  frameWidth: number,
  frameHeight: number,
  margin = 0,
  spacing = 0,
): TextureFrame[] {
  // Phaser 里的命名很别扭：`row` 是「一行放几帧」（按图宽算），
  // `column` 是「一列有几行」（按图高算）。这里保留它的命名，
  // 免得跟原实现对不上时看不出是哪边错了。
  const row = Math.floor((imageWidth - margin + spacing) / (frameWidth + spacing));
  const column = Math.floor((imageHeight - margin + spacing) / (frameHeight + spacing));
  const total = row * column;

  const frames: TextureFrame[] = [];
  for (let i = 0; i < total; i++) {
    const fx = margin + (i % row) * (frameWidth + spacing);
    const fy = margin + Math.floor(i / row) * (frameHeight + spacing);

    // 贴图右边缘/下边缘的帧会「放不下」—— Phaser 把它们裁窄。
    const ax = fx + frameWidth > imageWidth ? fx + frameWidth - imageWidth : 0;
    const ay = fy + frameHeight > imageHeight ? fy + frameHeight - imageHeight : 0;

    frames.push({
      x: fx,
      y: fy,
      width: frameWidth - ax,
      height: frameHeight - ay,
    });
  }
  return frames;
}

/**
 * 图片加载器 —— 返回一个能画的图片。
 *
 * 抽象出来是为了**能测**：单测里注入一个假的加载器，
 * 不必真的去下载图片。
 */
export type ImageLoader = (
  url: string,
) => Promise<{ image: CanvasImageSource; width: number; height: number }>;

/**
 * 默认加载器 —— 用浏览器的 `Image`。
 *
 * 加载完才 decode（`decode()`）—— 否则第一次画可能拿到一张还没解码完的图，
 * 画出来是空的。
 */
export const defaultImageLoader: ImageLoader = (url) =>
  new Promise((resolve, reject) => {
    if (typeof Image === "undefined") {
      reject(new Error("这个环境没有 `Image` —— 用不了默认加载器"));
      return;
    }
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const decode = (img as HTMLImageElement & { decode?: () => Promise<void> })
        .decode;
      if (typeof decode === "function") {
        decode()
          .then(() =>
            resolve({
              image: img,
              width: img.naturalWidth,
              height: img.naturalHeight,
            }),
          )
          .catch(() =>
            resolve({
              image: img,
              width: img.naturalWidth,
              height: img.naturalHeight,
            }),
          );
        return;
      }
      resolve({
        image: img,
        width: img.naturalWidth,
        height: img.naturalHeight,
      });
    };
    img.onerror = () => reject(new Error(`图片加载失败：${url}`));
    img.src = url;
  });
