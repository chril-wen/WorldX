/**
 * map-tile-generator.mjs
 * 地图扩展的底层能力：基于 outpainting（遮罩扩图）的自然扩展。
 *
 * 为什么用 outpainting 而不是「参考图重绘」：
 *   实测 Seedream 的纯参考图生成（整图参考、扩展画布、边缘条带参考）都会重绘
 *   全部内容，旧图像素无法保留。而 image_mask 字段能被 API 尊重——
 *   全黑 mask 测试中，画布的红/绿分区被原样保留，说明模型确实按 mask 只重绘标记区。
 *
 * 管线：
 *   1. 用 Vision 从旧图提取视觉风格
 *   2. 构造扩展画布（旧图 + 边缘延展的上下文）+ mask（旧图区 0 锁定，扩展区 255 生成）
 *   3. 调用 outpainting 生成
 *   4. 把旧图原样贴回，保证旧区域像素级不变
 *   5. 裁出新地块，供 Vision 单独解析坐标
 */

import sharp from "sharp";
import { buildOutpaintCanvas } from "./outpaint-canvas.mjs";
import { matchColorToReference } from "../../generators/map/color-match.mjs";

/** 扩展区用于「上下文延展」的旧图边缘条带宽度 */
const CONTEXT_STRIP_WIDTH = 96;

/**
 * 送进模型的旧图上下文宽度（像素）。
 *
 * 模型只需要看到接缝附近的一段旧图就能续写，把整张几千像素宽的图塞进去
 * 会显著拖慢生成：实测 3392x1536 的画布直接 524 超时，
 * 而 1408x1536 只要 34 秒就能完成。
 */
const CONTEXT_CROP_WIDTH = 768;

/**
 * 扩展方向的统一几何定义。
 *
 * 之前 4 个方向散落在各处用 if/else 判断，导致 left/top/bottom 三个方向
 * 实际上是「按 right 实现的」——边缘取样和接缝融合都取错了边。
 * 这里把每个方向涉及的所有几何量集中定义一次，其余代码只查表，
 * 新增方向时不会再漏改某处。
 *
 *   tileWidth/tileHeight  —— 新地块在扩展方向上的尺寸（另有一个方向上等于旧图边长）
 *   horizontal            —— 是否沿水平轴扩展
 *   seamAxis             —— 接缝所在的轴（'x' 表示接缝是竖线）
 */
export const EXPANSION_GEOMETRY = {
  right:  { horizontal: true,  seamAxis: "x", directionLabel: "向右", opposite: "left" },
  left:   { horizontal: true,  seamAxis: "x", directionLabel: "向左", opposite: "right" },
  bottom: { horizontal: false, seamAxis: "y", directionLabel: "向下", opposite: "top" },
  top:    { horizontal: false, seamAxis: "y", directionLabel: "向上", opposite: "bottom" },
};

/** 方向是否合法 */
export function isValidSide(side) {
  return Object.prototype.hasOwnProperty.call(EXPANSION_GEOMETRY, side);
}

/**
 * 计算新地块在完整画布中的位置与尺寸。
 *
 * @param {object} baseMeta - 旧图的 sharp metadata
 * @param {'right'|'left'|'bottom'|'top'} side
 * @param {number} extent - 扩展方向上新增的像素数（水平扩展=宽度，垂直扩展=高度）
 */
export function computeTileGeometry(baseMeta, side, extent) {
  const geom = EXPANSION_GEOMETRY[side];
  if (!geom) throw new Error(`Unknown expansion side: ${side}`);

  const baseW = baseMeta.width;
  const baseH = baseMeta.height;

  // 地块在「扩展方向」上的厚度是 extent，在「另一方向」上与旧图等长
  const tileWidth = geom.horizontal ? extent : baseW;
  const tileHeight = geom.horizontal ? baseH : extent;

  // 新地块在完整画布中的左上角
  let tileLeft = 0;
  let tileTop = 0;
  if (side === "right") tileLeft = baseW;
  else if (side === "bottom") tileTop = baseH;
  // left / top 的新地块在原点侧，偏移为 0

  const canvasWidth = baseW + (geom.horizontal ? extent : 0);
  const canvasHeight = baseH + (geom.horizontal ? 0 : extent);

  return { tileLeft, tileTop, tileWidth, tileHeight, canvasWidth, canvasHeight, horizontal: geom.horizontal };
}

/**
 * 从旧图中提取视觉风格描述，供新地块的生成 prompt 使用。
 */
export async function extractStyleFromImage(imageBuffer, { geminiProVisionJSON }) {
  const small = await resizeTo(imageBuffer, 1024);
  const prompt =
    "这是一张游戏俯视地图。请分析它的【视觉风格】，只描述风格本身，不要描述具体内容。\n" +
    "返回一个 JSON，包含以下字段：\n" +
    "{\n" +
    '  "artStyle": "整体美术风格（如：写实/水墨/像素/低多边形）",\n' +
    '  "palette": "主色调与配色倾向（色相、明度、饱和度）",\n' +
    '  "rendering": "笔触与渲染方式（如：淡墨晕染/硬边色块/柔和渐变）",\n' +
    '  "groundTexture": "地面材质与铺装纹理描述",\n' +
    '  "lighting": "光照与阴影处理",\n' +
    '  "edgeTreatment": "边缘与留白的处理方式",\n' +
    '  "cameraAngle": "视角与投影方式"\n' +
    "}\n" +
    "每个字段用中文，不超过 30 字。";

  try {
    const result = await geminiProVisionJSON(prompt, [small]);
    return result || {};
  } catch (e) {
    console.warn("[MapTile] Style extraction failed:", e.message);
    return {};
  }
}

/**
 * 把风格描述格式化成 prompt 片段。
 */
export function formatStyleHint(style) {
  if (!style || typeof style !== "object") return "";
  const parts = [];
  if (style.artStyle) parts.push("美术风格：" + style.artStyle);
  if (style.palette) parts.push("配色：" + style.palette);
  if (style.rendering) parts.push("渲染笔触：" + style.rendering);
  if (style.groundTexture) parts.push("地面材质：" + style.groundTexture);
  if (style.lighting) parts.push("光照：" + style.lighting);
  if (style.edgeTreatment) parts.push("边缘处理：" + style.edgeTreatment);
  if (style.cameraAngle) parts.push("视角：" + style.cameraAngle);
  if (parts.length === 0) return "";
  return (
    "\n\n## 必须严格复制的视觉风格\n" +
    parts.join("\n") +
    "\n（以上风格必须与现有地图完全一致）"
  );
}

/**
 * 用 outpainting 生成新地块。
 *
 * @param {object} opts
 * @param {Buffer} opts.referenceImage - 现有地图（只读，永不被重绘）
 * @param {string} opts.styleHint - 风格描述
 * @param {string} opts.contentPrompt - 新区域内容描述
 * @param {'right'|'left'|'bottom'|'top'} [opts.side] - 扩展方向
 * @param {number} [opts.tileWidth] - 新地块宽度（像素）
 * @param {(prompt: string, opts: object) => Promise<Buffer>} opts.generateImage
 * @returns {Promise<{canvas: Buffer, tile: Buffer, canvasWidth: number, canvasHeight: number,
 *                    tileLeft: number, tileTop: number, tileWidth: number, tileHeight: number}>}
 */
export async function generateMapTile(opts) {
  const {
    referenceImage,
    styleHint,
    continuationHint = "",
    contentPrompt,
    side = "right",
    // extent = 扩展方向上新增的像素厚度（水平扩展=宽度增量，垂直扩展=高度增量）。
    // 旧参数名 tileWidth 保留兼容，但它的语义一直是「增量」而非「地块宽度」——
    // 地块在另一方向上的长度等于旧图边长，由 buildOutpaintCanvas 决定。
    extent = 640,
    tileWidth,
    generateImage,
  } = opts;

  const expandExtent = tileWidth ?? extent;
  const geom = EXPANSION_GEOMETRY[side];
  if (!geom) throw new Error(`Unknown expansion side: ${side}`);

  // 构造扩展画布与 mask：旧图区 mask=0（锁定），扩展区 mask=255（生成）
  // 只送接缝附近的一小段旧图给模型（cropContextWidth），
  // 避免整张大画布导致生成超时；被裁掉的部分最后由原图贴回。
  const layout = await buildOutpaintCanvas(referenceImage, {
    side,
    tileWidth: expandExtent,
    contextWidth: CONTEXT_STRIP_WIDTH,
    cropContextWidth: CONTEXT_CROP_WIDTH,
  });

  const directionLabel = geom.directionLabel;

  const prompt =
    "【游戏地图扩图】这是一张游戏俯视地图，" +
    directionLabel +
    "的区域还没有内容，需要你补全。\n\n" +
    "## 要绘制的内容\n" +
    contentPrompt +
    styleHint +
    continuationHint +
    "\n\n## 硬性约束\n" +
    "1. 必须是接近90度的正上方俯视视角，平面图，不要透视、不要等距视角\n" +
    "2. 不能出现任何人物或角色\n" +
    "3. 不能出现任何文字、标签、招牌字样\n" +
    "4. 必须留出明显的可行走地面空间\n" +
    "5. 建筑只保留屋顶外观，不展示内部\n" +
    "6. 每一个被要求的地标（塔、桥、井、树等）都必须清晰可辨、形状完整，不要画成模糊色块\n" +
    "7. 地标周围要有与它相符的地表（塔基的青砖地面、小溪的河床与两岸草石）\n" +
    "8. 新区域与已有地图必须是同一个地点的相邻部分：道路要接上、水系要接上、建筑语汇要一致\n" +
    "9. 不要重绘已有地图的部分，只补全新区域";

  const outpainted = await generateImage(prompt, {
    aspectRatio: `${layout.canvasWidth}:${layout.canvasHeight}`,
    imageSize: "2K",
    logStep: "map-tile-outpaint",
    referenceImage: layout.canvas,
    maskImage: layout.mask,
  });

  // 模型返回的尺寸未必等于画布尺寸，先对齐到画布坐标系
  const outMeta = await sharp(outpainted).metadata();
  const scaled =
    outMeta.width === layout.canvasWidth && outMeta.height === layout.canvasHeight
      ? outpainted
      : await sharp(outpainted)
          .resize(layout.canvasWidth, layout.canvasHeight, { fit: "fill" })
          .png()
          .toBuffer();

    // 从画布中裁出新区部分
  const rawTile = await sharp(scaled)
    .extract({
      left: layout.tileLeft,
      top: layout.tileTop,
      width: layout.tileWidth,
      height: layout.tileHeight,
    })
    .png()
    .toBuffer();

  // 接缝延续：新区开头的一段由旧图边缘镜像延展而来，
  // 使旧图的边框走向、地面纹理与色调在接缝处连续过渡
  const continuedTile = await continueSeam(referenceImage, rawTile, side);

  // 色彩对齐：把新区整体色调拉到旧图的基准上（只作用于新区，旧图不动）
  let finalTile = continuedTile;
  try {
    finalTile = await matchColorToReference(continuedTile, referenceImage, 0.7);
  } catch (e) {
    console.warn("[MapTile] Color matching failed:", e.message);
  }

  // 旧图原样贴回 + 用处理后的新区覆盖画布的新区位置
  //
  // 裁剪模式下（layout.cropped），模型只处理了接缝附近的一段旧图，
  // 因此最终画布要按【原图尺寸】重建：把原图整体放回去，
  // 再把新区贴到扩展方向的位置。
  const baseMeta = await sharp(referenceImage).metadata();
  const fullWidth = baseMeta.width;
  const fullHeight = baseMeta.height;

  // 完整画布里旧图与新区的位置
  const fullBaseLeft = side === "left" ? expandExtent : 0;
  const fullBaseTop = side === "top" ? expandExtent : 0;
  const fullTileLeft = side === "left" ? 0 : side === "right" ? fullWidth : 0;
  const fullTileTop = side === "top" ? 0 : side === "bottom" ? fullHeight : 0;

  const fullCanvasWidth = fullWidth + (geom.horizontal ? expandExtent : 0);
  const fullCanvasHeight = fullHeight + (geom.horizontal ? 0 : expandExtent);

  // 以生成结果为底（新区像素来自模型），把原图贴回它自己的位置
  const finalCanvas = await sharp({
    create: {
      width: fullCanvasWidth,
      height: fullCanvasHeight,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .composite([
      { input: scaled, left: 0, top: 0 },
      { input: referenceImage, left: fullBaseLeft, top: fullBaseTop },
      { input: finalTile, left: fullTileLeft, top: fullTileTop },
    ])
    .png()
    .toBuffer();

  return {
    canvas: finalCanvas,
    tile: finalTile,
    // 最终画布（完整地图）的尺寸
    canvasWidth: fullCanvasWidth,
    canvasHeight: fullCanvasHeight,
    // 新地块在【完整画布】中的位置——调用方用它换算 region 的全局坐标
    tileLeft: fullTileLeft,
    tileTop: fullTileTop,
    tileWidth: layout.tileWidth,
    tileHeight: layout.tileHeight,
    baseWidth: baseMeta.width,
    baseHeight: baseMeta.height,
  };
}

/** 扩展方向是否为水平（左右）。 */
function horizontalFull(side) {
  return side === "right" || side === "left";
}

/** 接缝延续带宽度（像素）——旧图的边框/纹理向新区延续的距离 */
const SEAM_WIDTH = 180;

/**
 * 接缝延续：让新区开头的一段像素由旧图边缘镜像延展而来。
 *
 * 为什么需要：旧地图四周有一圈装饰边框和特定的留白/雾边处理，
 * 模型生成的新区不会自动复现它。直接硬贴会出现明显的边框断裂。
 * 这里把旧图边缘按 smoothstep 权重反向覆盖到新区开头，
 * 使「边框走向 + 地面纹理 + 色调」在接缝处连续过渡。
 *
 * 不做全局色彩匹配——那会破坏新区自身的层次。
 */
export async function continueSeam(base, tile, side, width = SEAM_WIDTH) {
  const baseMeta = await sharp(base).metadata();
  const tileMeta = await sharp(tile).metadata();
  const smoothstep = (t) => t * t * (3 - 2 * t);

  if (side === "right" || side === "left") {
    const H = tileMeta.height;
    const W = tileMeta.width;
    const bw = Math.min(width, W, baseMeta.width);

    const edge = await sharp(base)
      .extract({
        left: side === "right" ? baseMeta.width - bw : 0,
        top: 0,
        width: bw,
        height: baseMeta.height,
      })
      .resize({ width: bw, height: H, fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const t = await sharp(tile).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const out = Buffer.from(t.data);

    for (let j = 0; j < bw; j++) {
      // j=0 完全用旧图边缘（与旧图末像素连续），j=bw-1 完全用新生成内容
      const raw = side === "right" ? 1 - j / bw : j / bw;
      const k = smoothstep(raw);
      const srcCol = side === "right" ? bw - 1 - j : j;
      for (let y = 0; y < H; y++) {
        const ti = (y * W + j) * 3;
        const ei = (y * bw + srcCol) * 3;
        for (let c = 0; c < 3; c++) {
          out[ti + c] = Math.round(t.data[ti + c] * (1 - k) + edge.data[ei + c] * k);
        }
      }
    }
    return sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  }

  // ── 垂直方向（bottom / top）─────────────────────────────────────────────
  //
  // 接缝位置随方向而变：
  //   bottom —— 新区在下，接缝是【新区第一行】紧接旧图最后一行
  //   top    —— 新区在上，接缝是【新区最后一行】紧接旧图第一行
  // 之前的实现不管哪个方向都从新区【顶部】开始混合，于是向上扩展时
  // 融合的是新区的开头，而那里离接缝最远——接缝自然对不上。
  const W = tileMeta.width;
  const H = tileMeta.height;
  const bh = Math.min(width, H, baseMeta.height);

  // 旧图接缝侧的条带
  const edge = await sharp(base)
    .extract({
      left: 0,
      top: side === "bottom" ? baseMeta.height - bh : 0,
      width: baseMeta.width,
      height: bh,
    })
    .resize({ width: W, height: bh, fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const t = await sharp(tile).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.from(t.data);

  for (let j = 0; j < bh; j++) {
    // j=0 是紧贴旧图的那一行，完全用旧图边缘；j 增大逐渐过渡到新生成内容
    const k = smoothstep(1 - j / bh);
    // 新区里离接缝最近的行
    const tileRow = side === "bottom" ? j : H - 1 - j;
    // 旧图里离接缝最近的行
    const srcRow = side === "bottom" ? bh - 1 - j : j;
    for (let x = 0; x < W; x++) {
      const ti = (tileRow * W + x) * 3;
      const ei = (srcRow * W + x) * 3;
      for (let c = 0; c < 3; c++) {
        out[ti + c] = Math.round(t.data[ti + c] * (1 - k) + edge.data[ei + c] * k);
      }
    }
  }
  return sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}

/**
 * 分析旧图在扩展方向上的边缘，判断「什么空间元素正在穿越这条边界」。
 *
 * 这是让新区看起来像同一个地方的关键：旧图右边缘如果有一条路延伸到边界外，
 * 新区就必须有同一条路接上来；如果是河道，就必须是同一条河。
 * 只靠风格描述（配色、笔触）不足以让两块图像一张图。
 */
export async function analyzeEdgeContinuation(imageBuffer, side, { geminiProVisionJSON }) {
  const meta = await sharp(imageBuffer).metadata();
  const W = meta.width;
  const H = meta.height;
  const geom = EXPANSION_GEOMETRY[side];
  if (!geom) throw new Error(`Unknown expansion side: ${side}`);

  // 截取【扩展方向那一侧】的边缘条带，放大让 Vision 能看清细节。
  // 之前只区分了 right 和「其它」——left/top/bottom 全都取了顶部条带，
  // 于是向上扩展时分析的根本不是上边缘，接缝提示自然是错的。
  const STRIP = 220;
  let strip;
  if (geom.horizontal) {
    // 左右扩展：取左右某一侧的竖条
    const stripWidth = Math.min(STRIP, W);
    const left = side === "right" ? W - stripWidth : 0;
    strip = await sharp(imageBuffer)
      .extract({ left, top: 0, width: stripWidth, height: H })
      .resize({ width: 640, height: H, fit: "fill" })
      .toBuffer();
  } else {
    // 上下扩展：取上/下某一侧的横条
    const stripHeight = Math.min(STRIP, H);
    const top = side === "bottom" ? H - stripHeight : 0;
    strip = await sharp(imageBuffer)
      .extract({ left: 0, top, width: W, height: stripHeight })
      .resize({ width: W, height: 640, fit: "fill" })
      .toBuffer();
  }

  const prompt =
    "这是一张游戏俯视地图的【边缘条带】，画面的一侧是地图内部，另一侧是地图的边界之外。\n" +
    "请只分析「哪些空间元素正朝着边界外延伸」，不要描述具体建筑名称。\n\n" +
    "返回一个 JSON：\n" +
    "{\n" +
    '  "crossingElements": ["正在越过边界的元素，如：石板路/河道/石桥/围墙/树篱/屋檐/无"],\n' +
    '  "edgeCharacter": "边界处是什么景象（一句话，如：街道在这里被树丛遮断、河岸在这里转出画面）",\n' +
    '  "continuationRules": ["新区必须如何延续这些元素，每条一句话"],\n' +
    '  "buildingsVocabulary": "旧图里出现的建筑类型概括（如：木结构坡顶民居/临水吊脚楼/石砌塔），用于让新区建筑语汇一致"\n' +
    "}";

  try {
    const result = await geminiProVisionJSON(prompt, [strip]);
    return result || {};
  } catch (e) {
    console.warn("[MapTile] Edge analysis failed:", e.message);
    return {};
  }
}

/**
 * 把边缘分析结果格式化成 prompt 片段。
 */
export function formatContinuationHint(analysis) {
  if (!analysis || typeof analysis !== "object") return "";
  const parts = [];

  if (Array.isArray(analysis.crossingElements) && analysis.crossingElements.length > 0) {
    const list = analysis.crossingElements.filter((e) => e && !/^无$/.test(e)).join("、");
    if (list) {
      parts.push(
        "旧图边界处正有这些元素向外延伸（必须在新区里原样接上）：" + list,
      );
    }
  }
  if (analysis.edgeCharacter) {
    parts.push("旧图边界处的景象：" + analysis.edgeCharacter);
  }
  if (Array.isArray(analysis.continuationRules) && analysis.continuationRules.length > 0) {
    parts.push("衔接要求：\n" + analysis.continuationRules.map((r) => "  - " + r).join("\n"));
  }
  if (analysis.buildingsVocabulary) {
    parts.push("新区的建筑语汇必须与旧图一致（旧图用的是：" + analysis.buildingsVocabulary + "）");
  }
  if (parts.length === 0) return "";
  return "\n\n## 与旧地图的衔接（最重要）\n" + parts.join("\n");
}

/**
 * 缩放图片到指定最长边。
 */
export async function resizeTo(buffer, maxDim) {
  const meta = await sharp(buffer).metadata();
  const w = meta.width || 1;
  const h = meta.height || 1;
  const scale = Math.min(1, maxDim / Math.max(w, h));
  if (scale === 1) return buffer;
  return sharp(buffer)
    .resize(Math.round(w * scale), Math.round(h * scale), { fit: "inside" })
    .png()
    .toBuffer();
}