/**
 * outpaint-canvas.mjs
 * 扩图（outpainting）的画布与 mask 构造。
 *
 * 原理：
 *   - 画布：旧图放在一侧，扩展区预填「上下文延展」内容
 *   - mask：单通道灰度。0 = 保持原样（锁定旧图），255 = 需要模型生成
 *
 * 扩展区预填的是旧图边缘的延展内容（而不是纯黑），
 * 这样模型能顺着已有纹理继续画，接缝更自然。
 */

import sharp from "sharp";

/**
 * 构造 outpainting 所需的画布与 mask。
 *
 * @param {Buffer} baseImage - 旧地图
 * @param {object} opts
 * @param {'right'|'left'|'bottom'|'top'} [opts.side] - 扩展方向
 * @param {number} [opts.tileWidth] - 扩展区宽度（像素）
 * @param {number} [opts.contextWidth] - 用于延展的旧图边缘条带宽度
 * @param {number} [opts.cropContextWidth] - 送进模型的旧图上下文宽度（0=不裁剪）。
 *   模型只需要看到接缝附近的一小段旧图来找���接续；把整张几千像素宽的图
 *   塞进去会显著拖慢生成（实测 3392x1536 直接 524 超时，1408x1536 只要 34 秒），
 *   还会让模型更容易重画整个画面。
 * @returns {Promise<{canvas: Buffer, mask: Buffer, offsetX: number, offsetY: number,
 *                    canvasWidth: number, canvasHeight: number, tileWidth: number, tileHeight: number}>}
 */
export async function buildOutpaintCanvas(baseImage, opts = {}) {
  const { side = "right", tileWidth = 640, contextWidth = 96, cropContextWidth = 0 } = opts;

  const meta = await sharp(baseImage).metadata();
  const W = meta.width;
  const H = meta.height;

  const horizontal = side === "right" || side === "left";
  const canvasWidth = horizontal ? W + tileWidth : W;
  const canvasHeight = horizontal ? H : H + tileWidth;

  // 旧图在新画布中的位置
  const baseLeft = side === "left" ? tileWidth : 0;
  const baseTop = side === "top" ? tileWidth : 0;

  // 新地块在画布中的位置
  const tileLeft = side === "left" ? 0 : side === "right" ? W : 0;
  const tileTop = side === "top" ? 0 : side === "bottom" ? H : 0;
  const tileH = horizontal ? H : tileWidth;
  const tileW = horizontal ? tileWidth : W;

  // ── 上下文裁剪 ────────────────────────────────────────────────────────────
  // 只把接缝附近的一小段旧图送进模型，其余旧图不参与生成。
  // 这样画布尺寸可控（生成时间与画布面积强相关），旧图也不会被模型重画。
  // 被裁掉的部分会在最后由原图贴回，所以内容不会有损失。
  let sourceImage = baseImage;
  let sourceW = W;
  let sourceH = H;
  // 裁剪后旧图在新画布中的位置
  let baseCropLeft = 0;
  let baseCropTop = 0;
  let baseCropW = W;
  let baseCropH = H;

  if (cropContextWidth > 0) {
    const cropW = Math.min(cropContextWidth, W);
    const cropH = Math.min(cropContextWidth, H);
    if (horizontal) {
      // 只保留接缝一侧的旧图条带
      const left = side === "right" ? W - cropW : 0;
      sourceImage = await sharp(baseImage)
        .extract({ left, top: 0, width: cropW, height: H })
        .png()
        .toBuffer();
      sourceW = cropW;
      // 向右扩展：旧图条带在画布左侧，新区在右侧；反之亦然
      baseCropLeft = side === "left" ? tileWidth : 0;
      baseCropW = cropW;
    } else {
      const top = side === "bottom" ? H - cropH : 0;
      sourceImage = await sharp(baseImage)
        .extract({ left: 0, top, width: W, height: cropH })
        .png()
        .toBuffer();
      sourceH = cropH;
      // 向下扩展：旧图条带在画布顶部，新区在底部；反之亦然
      baseCropTop = side === "top" ? tileWidth : 0;
      baseCropH = cropH;
    }
  }

  // ── 扩展区的上下文延展 ────────────────────────────────────────────────────
  // 取旧图在扩展方向上的边缘条带，镜像/平铺到扩展区，作为模型续写的起点
  let contextFill;
  if (side === "right") {
    const strip = await sharp(sourceImage)
      .extract({ left: sourceW - contextWidth, top: 0, width: contextWidth, height: sourceH })
      .resize({ width: tileWidth, height: sourceH, fit: "fill" })
      .flop()
      .toBuffer();
    contextFill = strip;
  } else if (side === "left") {
    const strip = await sharp(sourceImage)
      .extract({ left: 0, top: 0, width: contextWidth, height: sourceH })
      .resize({ width: tileWidth, height: sourceH, fit: "fill" })
      .flop()
      .toBuffer();
    contextFill = strip;
  } else if (side === "bottom") {
    const strip = await sharp(sourceImage)
      .extract({ left: 0, top: sourceH - contextWidth, width: sourceW, height: contextWidth })
      .resize({ width: sourceW, height: tileWidth, fit: "fill" })
      .flop()
      .toBuffer();
    contextFill = strip;
  } else {
    const strip = await sharp(sourceImage)
      .extract({ left: 0, top: 0, width: sourceW, height: contextWidth })
      .resize({ width: sourceW, height: tileWidth, fit: "fill" })
      .flop()
      .toBuffer();
    contextFill = strip;
  }

  // 裁剪后的画布尺寸
  const outCanvasWidth = horizontal ? sourceW + tileWidth : sourceW;
  const outCanvasHeight = horizontal ? sourceH : sourceH + tileWidth;
  // 新地块在「输出画布」中的位置
  const outTileLeft = side === "left" ? 0 : side === "right" ? sourceW : 0;
  const outTileTop = side === "top" ? 0 : side === "bottom" ? sourceH : 0;

  const canvas = await sharp({
    create: {
      width: outCanvasWidth,
      height: outCanvasHeight,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .composite([
      { input: sourceImage, left: baseCropLeft, top: baseCropTop },
      { input: contextFill, left: outTileLeft, top: outTileTop },
    ])
    .png()
    .toBuffer();

  // ── mask：旧图区 = 0（锁定），扩展区 = 255（生成） ─────────────────────────
  // sharp 的 create 不支持单通道，先用灰度色块构造，再转成真正的单通道 PNG
  const maskBase = await sharp({
    create: {
      width: outCanvasWidth,
      height: outCanvasHeight,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite([
      {
        input: await sharp({
          create: {
            width: sourceW,
            height: sourceH,
            channels: 3,
            background: { r: 0, g: 0, b: 0 },
          },
        })
          .png()
          .toBuffer(),
        left: baseCropLeft,
        top: baseCropTop,
      },
    ])
    .greyscale()
    .png()
    .toBuffer();

  // 裁剪信息：调用方需要知道新地块在【原图坐标系】里的位置
  const cropped = cropContextWidth > 0;
  // 被保留的旧图条带在原图坐标系里的左上角
  const cropLeft = cropped && horizontal ? (side === "right" ? W - baseCropW : 0) : 0;
  const cropTop = cropped && !horizontal ? (side === "bottom" ? H - baseCropH : 0) : 0;

  return {
    canvas,
    mask: maskBase,
    offsetX: baseCropLeft,
    offsetY: baseCropTop,
    canvasWidth: outCanvasWidth,
    canvasHeight: outCanvasHeight,
    tileWidth: tileW,
    tileHeight: tileH,
    tileLeft: outTileLeft,
    tileTop: outTileTop,
    cropped,
    cropLeft,
    cropTop,
    cropWidth: baseCropW,
    cropHeight: baseCropH,
    fullWidth: W,
    fullHeight: H,
  };
}
