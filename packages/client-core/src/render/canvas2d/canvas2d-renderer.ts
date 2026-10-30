/**
 * Canvas 2D 渲染器 —— 阶段 8.2。
 *
 * ## 它做什么
 *
 * 把 `RenderScene`（纯数据）画到一个 canvas 上。
 *
 * ```
 * mount(container) → render(scene) × N → resize(w, h) → dispose()
 * ```
 *
 * ## 它**不**做什么
 *
 * - **不碰位置计算** —— 坐标全部是 `scene-builder` 给好的世界坐标，
 *   这里只做一次「世界 → 屏幕」的变换（契约层给的公式）。
 * - **不碰业务** —— 不知道什么是「角色」「区域」「点位」，
 *   只知道 `rect` / `ellipse` / `text` 这些图元。
 * - **不画 DOM 覆盖层** —— 名牌和气泡是**另一个层**（见 `overlays.ts`）。
 *
 * ## 为什么 DOM 覆盖层单独一个文件
 *
 * 改造前，名牌和气泡是 `HTMLDivElement` + CSS，
 * 画在 canvas **之上**（`#label-root`，`z-index: 2`）。
 *
 * 契约把它们单列成 `OverlayItem`（见 `render-model.ts`）——
 * 渲染实现可以用 DOM 画（跟旧实现一样），也可以改成 canvas 画。
 *
 * 本实现**继续用 DOM**：旧实现的 CSS 是现成的观感基准，
 * 重画一遍只会引入差异 —— 阶段 8.2 的验收标准是「视觉一致」。
 *
 * ## 变换
 *
 * 契约给的公式（`render-model.ts`）：
 *
 * ```
 * screenX = (worldX - scrollX) * zoom + viewportX
 * screenY = (worldY - scrollY) * zoom + viewportY
 * ```
 *
 * 实现上直接用 canvas 的 `setTransform` 表达这个变换 ——
 * 于是**画图元时可以直接用世界坐标**，不用每个图元手动换算。
 *
 * ## 关于 DPR（设备像素比）
 *
 * 画布的**位图尺寸**按 DPR 放大，但**变换矩阵**里再除回去，
 * 这样 CSS 像素下的观感跟旧实现一致（文字不会在高分屏上糊成一团）。
 *
 * ## 为什么不用 `Path2D`
 *
 * `Path2D` 在 Node 里**不存在**（只��浏览器有）。
 * 用它的话，单测就得先造一个 DOM 环境 —— 而单测要验的
 * 是「画了什么、画在哪」，跟浏览器没关系。
 *
 * 所以这里只用 `ctx` 上最基础的那几个方法
 * （`beginPath` / `moveTo` / `lineTo` / `arcTo` / `ellipse` / `rect`），
 * 单测注入一个**记录式**的 2D 上下文就能逐点验。
 */

import type {
  CameraState,
  DrawEllipse,
  DrawImage,
  DrawItem,
  DrawPolygon,
  DrawPolyline,
  DrawRect,
  DrawSprite,
  DrawText,
  RenderScene,
  SceneRenderer,
} from "../render-model.js";
import { screenToWorld } from "../render-model.js";
import {
  buildSpriteSheetFrames,
  defaultImageLoader,
  type ImageLoader,
  type Texture,
  type TextureSpec,
} from "./textures.js";

/**
 * 渲染器用到的 2D 上下文**子集**。
 *
 * 为什么不用 `CanvasRenderingContext2D` 全量：
 *
 * 1. 单测要注入一个**记录式**的替身 —— 全量接口太大，替不动
 * 2. 契约层要能画的东西就那么几样，用不着那么多 API
 *
 * 真 canvas 的上下文**满足**这个接口（结构化类型）。
 */
export interface Surface2D {
  /* ── 样式 ── */
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  lineJoin: string;
  lineCap: string;
  globalAlpha: number;
  globalCompositeOperation: string;
  font: string;
  textBaseline: string;

  /* ── 状态 ── */
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  scale(x: number, y: number): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;

  /* ── 画 ── */
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void;
  ellipse(
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
    startAngle: number,
    endAngle: number,
    counterclockwise?: boolean,
  ): void;
  fill(): void;
  stroke(): void;
  fillText(text: string, x: number, y: number): void;
  strokeText(text: string, x: number, y: number): void;
  drawImage(
    image: CanvasImageSource,
    sx: number,
    sy: number,
    sWidth: number,
    sHeight: number,
    dx: number,
    dy: number,
    dWidth: number,
    dHeight: number,
  ): void;
  measureText(text: string): {
    width: number;
    actualBoundingBoxAscent?: number;
    actualBoundingBoxDescent?: number;
    fontBoundingBoxAscent?: number;
    fontBoundingBoxDescent?: number;
  };
  rect(x: number, y: number, w: number, h: number): void;
}

/** 渲染器需要的画布 —— 只要尺寸和一个上下文。 */
export interface SurfaceCanvas {
  width: number;
  height: number;
  style: { display: string; width: string; height: string };
  getContext(type: "2d"): Surface2D | null;
  /** 挂到 DOM 上（真 canvas 有）。 */
  remove?: () => void;
}

/** 造一张画布的工厂 —— 单测注入假的。 */
export type CanvasFactory = (width: number, height: number) => SurfaceCanvas;

/** 渲染器的可选项。 */
export interface Canvas2DRendererOptions {
  /**
   * 图片加载器 —— 「source 字符串 → 能画的图片」。
   *
   * 默认用浏览器的 `Image`。单测注入假的加载器。
   */
  loadImage?: ImageLoader;
  /**
   * 贴图来源表 —— 「source 字符串 → 去哪儿拿这张图」。
   *
   * 契约里的 `source` 是**不透明字符串**，渲染实现自己解释：
   *
   * - `DrawImage.source` —— 直接当 URL（地图底图就是这么用的）
   * - `DrawSprite.source` —— 角色贴图的**纹理 key**，要靠这张表翻译成 URL
   *
   * 表里没有的 key 走**默认规则**（见 `resolveSpec`）。
   */
  textureSources?: Record<string, TextureSpec>;
  /** 设备像素比 —— 用来放大画布位图。默认取 `window.devicePixelRatio`。 */
  devicePixelRatio?: number;
  /** 造画布的工厂 —— 默认用 `document.createElement("canvas")`。 */
  createCanvas?: CanvasFactory;
}

/**
 * Canvas 2D 渲染器。
 *
 * ## 状态
 *
 * - `canvas` —— 挂载时创建，卸载时移除
 * - `textures` —— 已加载的贴图（`source` → `Texture`）
 * - `pending` —— 正在加载的贴图（去重，避免同一张图加载两次）
 * - `lastScene` —— 最近一次渲染的场景（`hitTest` 要用）
 */
export class Canvas2DSceneRenderer implements SceneRenderer {
  private container: HTMLElement | null = null;
  private canvas: SurfaceCanvas | null = null;
  private ctx: Surface2D | null = null;

  private readonly loadImage: ImageLoader;
  private readonly textureSources: Record<string, TextureSpec>;
  private readonly dpr: number;
  private readonly createCanvas: CanvasFactory;

  private textures = new Map<string, Texture>();
  private pending = new Map<string, Promise<void>>();

  private width = 0;
  private height = 0;

  private lastScene: RenderScene | null = null;

  /**
   * 贴图加载完的钩子 —— 由外部接上「重画一帧」。
   *
   * 加载是异步的，图到得晚 —— 没有这个钩子，图会一直缺失。
   */
  onTextureLoaded: (() => void) | null = null;

  constructor(options: Canvas2DRendererOptions = {}) {
    this.loadImage = options.loadImage ?? defaultImageLoader;
    this.textureSources = options.textureSources ?? {};
    this.dpr =
      options.devicePixelRatio ??
      (typeof window !== "undefined" ? window.devicePixelRatio : 1);
    this.createCanvas = options.createCanvas ?? defaultCanvasFactory;
  }

  /* ── 生命周期 ────────────────────────────────────────────── */

  mount(container: HTMLElement): void {
    this.container = container;

    const rect = container.getBoundingClientRect();
    const width = rect.width || container.clientWidth || 800;
    const height = rect.height || container.clientHeight || 600;

    const canvas = this.createCanvas(width, height);
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    container.appendChild(canvas as unknown as Node);

    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");

    this.resize(width, height);
  }

  unmount(): void {
    const canvas = this.canvas as unknown as { remove?: () => void } | null;
    if (canvas) {
      if (typeof canvas.remove === "function") canvas.remove();
      else if (this.container && canvas instanceof Object) {
        const parent = (canvas as unknown as { parentNode?: Node | null }).parentNode;
        parent?.removeChild(canvas as unknown as Node);
      }
    }
    this.canvas = null;
    this.ctx = null;
    this.container = null;
    this.lastScene = null;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    const canvas = this.canvas;
    if (!canvas) return;

    const dpr = this.dpr;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }

  dispose(): void {
    this.unmount();
    this.textures.clear();
    this.pending.clear();
  }

  /* ── 渲染 ────────────────────────────────────────────────── */

  render(scene: RenderScene): void {
    this.lastScene = scene;

    const ctx = this.ctx;
    if (!ctx) return;

    const dpr = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.width * dpr, this.height * dpr);

    // 相机变换 —— 之后所有图元都直接用世界坐标画。
    //
    // `setTransform(zoom, 0, 0, zoom, tx, ty)` 展开就是
    // `screenX = worldX * zoom + tx`，令 `tx = viewportX - scrollX * zoom`
    // 就正好是契约里的公式（见 `render-model.ts`）。
    const camera = scene.camera;
    ctx.setTransform(
      camera.zoom * dpr,
      0,
      0,
      camera.zoom * dpr,
      (camera.viewportX - camera.scrollX * camera.zoom) * dpr,
      (camera.viewportY - camera.scrollY * camera.zoom) * dpr,
    );

    this.drawBackground(scene);

    // 图层按 depth 升序 —— 后面的盖前面的。
    const layers = [...scene.layers].sort((a, b) => a.depth - b.depth);
    for (const layer of layers) {
      for (const item of layer.items) {
        this.drawItem(item);
      }
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** 画地图底图。 */
  private drawBackground(scene: RenderScene): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const texture = this.textures.get(scene.background.source);
    if (!texture) {
      this.ensureTexture(scene.background.source, undefined);
      return;
    }
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.drawImage(
      texture.image,
      0,
      0,
      texture.width,
      texture.height,
      0,
      0,
      scene.background.width,
      scene.background.height,
    );
    ctx.restore();
  }

  /** 画一个图元。 */
  private drawItem(item: DrawItem): void {
    switch (item.kind) {
      case "image":
        this.drawImage(item);
        break;
      case "rect":
        this.drawRect(item);
        break;
      case "ellipse":
        this.drawEllipse(item);
        break;
      case "polygon":
        this.drawPolygon(item);
        break;
      case "text":
        this.drawText(item);
        break;
      case "sprite":
        this.drawSprite(item);
        break;
      case "polyline":
        this.drawPolyline(item);
        break;
    }
  }

  /**
   * 图片。
   *
   * `source` 在 Canvas 2D 里就是**图片地址**（契约层不规定，
   * 由实现决定 —— 见 `render-model.ts` 的说明）。
   */
  private drawImage(item: DrawImage): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const texture = this.textures.get(item.source);
    if (!texture) {
      this.ensureTexture(item.source, undefined);
      return;
    }
    ctx.save();
    ctx.globalAlpha = item.alpha ?? 1;
    ctx.drawImage(
      texture.image,
      0,
      0,
      texture.width,
      texture.height,
      item.x,
      item.y,
      item.width,
      item.height,
    );
    ctx.restore();
  }

  /**
   * 矩形（可圆角）。
   *
   * 旧实现里圆角矩形用 `fillRoundedRect` —— 圆角是**观感的一部分**
   * （悬停高亮、气泡底），抹掉就等于改了产品。
   */
  private drawRect(item: DrawRect): void {
    const ctx = this.ctx;
    if (!ctx) return;

    ctx.save();
    ctx.globalAlpha = item.alpha ?? 1;

    this.traceRectPath(ctx, item.x, item.y, item.width, item.height, item.radius);

    if (item.fill) {
      ctx.fillStyle = item.fill;
      ctx.fill();
    }
    if (item.stroke) {
      ctx.strokeStyle = item.stroke;
      ctx.lineWidth = item.lineWidth ?? 1;
      ctx.stroke();
    }
    ctx.restore();
  }

  /** 描一个（可圆角的）矩形路径。 */
  private traceRectPath(
    ctx: Surface2D,
    x: number,
    y: number,
    width: number,
    height: number,
    radius?: number,
  ): void {
    ctx.beginPath();
    if (!radius || radius <= 0) {
      ctx.rect(x, y, width, height);
      return;
    }
    // 半径限幅到短边一半 —— 否则 `arcTo` 会画出奇怪的形状。
    const r = Math.min(radius, width / 2, height / 2);
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.arcTo(x + width, y, x + width, y + r, r);
    ctx.lineTo(x + width, y + height - r);
    ctx.arcTo(x + width, y + height, x + width - r, y + height, r);
    ctx.lineTo(x + r, y + height);
    ctx.arcTo(x, y + height, x, y + height - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  /**
   * 椭圆 / 圆 / 弧。
   *
   * `arcStart`/`arcEnd` 给了就是弧（度），不给就是整圆。
   */
  private drawEllipse(item: DrawEllipse): void {
    const ctx = this.ctx;
    if (!ctx) return;

    ctx.save();
    ctx.globalAlpha = item.alpha ?? 1;

    const rx = Math.abs(item.radiusX);
    const ry = Math.abs(item.radiusY);

    ctx.beginPath();
    if (item.arcStart !== undefined || item.arcEnd !== undefined) {
      // 弧：从起始角画到终止角（度 → 弧度）。
      //
      // Phaser 的 `add.arc` 用的是**度**，默认顺时针 ——
      // 契约里也是度，直接换算即可。
      const start = ((item.arcStart ?? 0) * Math.PI) / 180;
      const end = ((item.arcEnd ?? 360) * Math.PI) / 180;
      ctx.ellipse(item.x, item.y, rx, ry, 0, start, end);
    } else {
      ctx.ellipse(item.x, item.y, rx, ry, 0, 0, Math.PI * 2);
    }

    if (item.fill) {
      ctx.fillStyle = item.fill;
      ctx.fill();
    }
    if (item.stroke) {
      ctx.strokeStyle = item.stroke;
      ctx.lineWidth = item.lineWidth ?? 1;
      ctx.stroke();
    }
    ctx.restore();
  }

  /** 多边形 —— 现有画法里只有气泡的尾巴。 */
  private drawPolygon(item: DrawPolygon): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (item.points.length === 0) return;

    ctx.save();
    ctx.globalAlpha = item.alpha ?? 1;

    ctx.beginPath();
    item.points.forEach((point, index) => {
      const px = item.x + point.x;
      const py = item.y + point.y;
      if (index === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.closePath();

    if (item.fill) {
      ctx.fillStyle = item.fill;
      ctx.fill();
    }
    if (item.stroke) {
      ctx.strokeStyle = item.stroke;
      ctx.lineWidth = item.lineWidth ?? 1;
      ctx.stroke();
    }
    ctx.restore();
  }

  /** 折线 —— 寻路路径这类连线。 */
  private drawPolyline(item: DrawPolyline): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (item.points.length === 0) return;

    ctx.save();
    ctx.globalAlpha = item.alpha ?? 1;
    ctx.strokeStyle = item.stroke;
    ctx.lineWidth = item.lineWidth;
    ctx.beginPath();
    item.points.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.stroke();
    ctx.restore();
  }

  /**
   * 文本。
   *
   * ## 复刻 Phaser 的画法
   *
   * Phaser 的 `Text` 画在一张**离屏 canvas** 上，然后当贴图贴出去。
   * 关键几点这里逐条对齐：
   *
   * 1. **背景**铺满整个框（**含 padding**）
   * 2. **描边在文字下面**（先 `strokeText` 再 `fillText`）
   * 3. 描边粗细**占尺寸**：框宽 = `ceil(文字宽 + 描边粗细) + 左右内边距`
   * 4. 文字画在 `(x + padding.left, y + padding.top)`，基线偏移 `描边粗细 / 2`
   *
   * 描边占尺寸这条最容易走偏 —— 少算它，chip 会比旧实现窄一个描边粗细。
   */
  private drawText(item: DrawText): void {
    const ctx = this.ctx;
    if (!ctx) return;

    const padding = {
      left: item.padding?.left ?? 0,
      right: item.padding?.right ?? 0,
      top: item.padding?.top ?? 0,
      bottom: item.padding?.bottom ?? 0,
    };
    const strokeThickness = item.strokeThickness ?? 0;

    ctx.save();
    ctx.globalAlpha = item.alpha ?? 1;
    ctx.font = item.font;
    ctx.textBaseline = "alphabetic";

    // 换行 —— `maxWidth` 给了就按它折行（照抄 Phaser 的 `useAdvancedWrap`）。
    const lines = item.maxWidth
      ? wrapText(ctx, item.content, item.maxWidth)
      : item.content.split("\n");

    const measured = this.measureText(item);
    const lineHeight = measured.lineHeight;
    const ascent = measured.ascent;

    // 每一行的宽度 —— 照抄 Phaser 的 `textSize.lineWidths[i]`：
    // `ceil(描边粗细 + 文字宽)`。
    //
    // 描边是**往外**画的，所以它占宽度 —— 不算它，
    // 「居中」对齐的 chip 会偏半个描边。
    const lineWidths = lines.map((line) =>
      Math.ceil(ctx.measureText(line).width + strokeThickness),
    );
    const textWidth = lineWidths.length
      ? Math.max(...lineWidths)
      : 0;

    // 框的尺寸 —— 照抄 Phaser 的 `updateText()`：
    //
    // ```
    // this.width  = textSize.width  + padding.left + padding.right
    // this.height = textSize.height + padding.top  + padding.bottom
    // ```
    //
    // `textSize.height` 是 `行高 × 行数` —— 多行时框要更高。
    // 契约给了尺寸就用契约的（那是 builder 按同一套公式算的）。
    const boxWidth =
      item.width ?? textWidth + padding.left + padding.right;
    const boxHeight =
      item.height ??
      lineHeight * lines.length + padding.top + padding.bottom;

    // 背景 —— 铺满整个框。
    if (item.background) {
      ctx.save();
      ctx.globalAlpha = (item.alpha ?? 1) * (item.backgroundAlpha ?? 1);
      ctx.fillStyle = item.background;
      ctx.fillRect(item.x, item.y, boxWidth, boxHeight);
      ctx.restore();
    }

    lines.forEach((line, index) => {
      const lineWidth = lineWidths[index];

      // Phaser 把文字画在一张**离屏 canvas** 上，
      // 画完再把那张 canvas 贴到 (x, y)。
      //
      // 所以这里的坐标是「**离屏画布内的局部坐标**」：
      //
      // ```
      // linePositionX = strokeThickness / 2
      // linePositionY = (strokeThickness / 2 + i * lineHeight) + ascent
      // context.translate(padding.left, padding.top)
      // ```
      //
      // 最后那步 `translate` 在**取整之外** ——
      // Phaser 先把局部坐标取整，再由画布自己的位置加上 padding。
      //
      // 所以顺序必须是：**先取整局部坐标，再加世界坐标**。
      // 直接把世界坐标取整，在 x/y 是小数时会差一个像素。
      let localX = strokeThickness / 2;
      const localY = strokeThickness / 2 + index * lineHeight + ascent;

      // 对齐 —— 相对**文字区**（最宽的一行）对齐，跟 Phaser 一致。
      if (item.align === "center") {
        localX += (textWidth - lineWidth) / 2;
      } else if (item.align === "right") {
        localX += textWidth - lineWidth;
      }

      // Phaser 的 `autoRound` 默认是 `true` —— 文字位置**取整**。
      //
      // 不取整的话，14px 的字会落在半像素上，浏览器会做抗锯齿补偿 ——
      // 同一个字在两个位置看起来不一样粗。
      const lineX = item.x + padding.left + Math.round(localX);
      const lineY = item.y + padding.top + Math.round(localY);

      // 描边先画（在底下），再画填充。
      if (item.stroke && strokeThickness > 0) {
        ctx.strokeStyle = item.stroke;
        ctx.lineWidth = strokeThickness;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.strokeText(line, lineX, lineY);
      }
      ctx.fillStyle = item.color;
      ctx.fillText(line, lineX, lineY);
    });

    ctx.restore();
  }

  /**
   * 精灵 —— 有贴图的角色。
   *
   * 锚点（`originX`/`originY`）决定贴图**贴在哪** ——
   * 角色的 `originY = 0.85` 决定脚底在哪，也就决定了名牌挂哪儿。
   */
  private drawSprite(item: DrawSprite): void {
    const ctx = this.ctx;
    if (!ctx) return;

    const texture = this.textures.get(item.source);
    if (!texture) {
      this.ensureTexture(item.source, undefined);
      return;
    }

    const originX = item.originX ?? 0.5;
    const originY = item.originY ?? 0.5;

    // 帧 —— 贴图集里按帧号取；没有贴图集就画整张。
    let sx = 0;
    let sy = 0;
    let sw = texture.width;
    let sh = texture.height;
    if (texture.frames && texture.frames.length > 0) {
      const frame = texture.frames[item.frame ?? 0] ?? texture.frames[0];
      sx = frame.x;
      sy = frame.y;
      sw = frame.width;
      sh = frame.height;
    }

    const destX = item.x - item.width * originX;
    const destY = item.y - item.height * originY;

    ctx.save();
    ctx.globalAlpha = item.alpha ?? 1;

    if (item.flipX) {
      // 水平翻转 —— 画到临时画布上再镜像贴回去。
      //
      // 直接用负缩放画也行，但源矩形和目标矩形要一起变，
      // 容易搞错 —— 用临时画布更直白。
      const flipped = this.getScratchCanvas(sw, sh);
      const fctx = flipped.getContext("2d");
      if (fctx) {
        fctx.clearRect(0, 0, flipped.width, flipped.height);
        fctx.save();
        fctx.translate(flipped.width, 0);
        fctx.scale(-1, 1);
        fctx.drawImage(texture.image, sx, sy, sw, sh, 0, 0, sw, sh);
        fctx.restore();
        this.drawTinted(
          flipped as unknown as CanvasImageSource,
          item,
          destX,
          destY,
          item.width,
          item.height,
        );
      }
    } else {
      this.drawTinted(
        texture.image,
        item,
        destX,
        destY,
        item.width,
        item.height,
        sx,
        sy,
        sw,
        sh,
      );
    }

    ctx.restore();
  }

  /**
   * 画一张（可能带染色的）图。
   *
   * **染色**（`tint`）用「临时画布 + 源进去」的做法：
   * 先把源画进临时画布，再叠一层颜色（`source-in`）——
   * 效果跟 Phaser 的 `setTint` 一致（保留 alpha 形状）。
   */
  private drawTinted(
    source: CanvasImageSource,
    item: DrawSprite,
    destX: number,
    destY: number,
    destWidth: number,
    destHeight: number,
    sx = 0,
    sy = 0,
    sw?: number,
    sh?: number,
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;

    if (!item.tint) {
      if (sw === undefined || sh === undefined) {
        ctx.drawImage(source, 0, 0, sourceWidth(source), sourceHeight(source), destX, destY, destWidth, destHeight);
      } else {
        ctx.drawImage(source, sx, sy, sw, sh, destX, destY, destWidth, destHeight);
      }
      return;
    }

    const tintCanvas = this.getScratchCanvas(sw ?? destWidth, sh ?? destHeight);
    const tctx = tintCanvas.getContext("2d");
    if (!tctx) return;

    tctx.clearRect(0, 0, tintCanvas.width, tintCanvas.height);
    tctx.drawImage(
      source,
      sx,
      sy,
      sw ?? sourceWidth(source),
      sh ?? sourceHeight(source),
      0,
      0,
      tintCanvas.width,
      tintCanvas.height,
    );
    tctx.globalCompositeOperation = "source-in";
    tctx.fillStyle = item.tint;
    tctx.fillRect(0, 0, tintCanvas.width, tintCanvas.height);
    tctx.globalCompositeOperation = "source-over";

    ctx.drawImage(
      tintCanvas as unknown as CanvasImageSource,
      0,
      0,
      tintCanvas.width,
      tintCanvas.height,
      destX,
      destY,
      destWidth,
      destHeight,
    );  }

  /* ── 命中测试 ────────────────────────────────────────────── */

  /**
   * 屏幕坐标 → 图元 id。
   *
   * ## 命中顺序
   *
   * **从最上面往下找** —— 后面的盖前面的，上面先命中。
   * 这跟 Phaser 的 `topOnly` 输入排序一致
   * （`sortGameObjects` 按渲染列表倒序排）。
   *
   * 命中的是**图元的几何形状**，不是包围盒 ——
   * 圆角矩形的角上不该命中。
   */
  hitTest(screenX: number, screenY: number): string | null {
    const scene = this.lastScene;
    if (!scene) return null;

    const world = screenToWorld(scene.camera, screenX, screenY);
    const layers = [...scene.layers].sort((a, b) => b.depth - a.depth);

    for (const layer of layers) {
      for (let i = layer.items.length - 1; i >= 0; i--) {
        const item = layer.items[i];
        if (item.kind === "rect" && this.hitRect(item, world.x, world.y)) {
          return item.id;
        }
        if (item.kind === "ellipse" && this.hitEllipse(item, world.x, world.y)) {
          return item.id;
        }
        if (item.kind === "sprite" && this.hitSprite(item, world.x, world.y)) {
          return item.id;
        }
      }
    }
    return null;
  }

  private hitRect(item: DrawRect, x: number, y: number): boolean {
    if (x < item.x || x > item.x + item.width) return false;
    if (y < item.y || y > item.y + item.height) return false;

    // 圆角矩形的角上**不命中**。
    const radius = item.radius ?? 0;
    if (radius <= 0) return true;

    const left = item.x + radius;
    const right = item.x + item.width - radius;
    const top = item.y + radius;
    const bottom = item.y + item.height - radius;

    if (x < left && y < top) return distToCorner(x, y, left, top) <= radius;
    if (x > right && y < top) return distToCorner(x, y, right, top) <= radius;
    if (x < left && y > bottom) return distToCorner(x, y, left, bottom) <= radius;
    if (x > right && y > bottom) return distToCorner(x, y, right, bottom) <= radius;
    return true;
  }

  private hitEllipse(item: DrawEllipse, x: number, y: number): boolean {
    const rx = Math.abs(item.radiusX);
    const ry = Math.abs(item.radiusY);
    if (rx === 0 || ry === 0) return false;
    const dx = (x - item.x) / rx;
    const dy = (y - item.y) / ry;
    return dx * dx + dy * dy <= 1;
  }

  /**
   * 精灵命中 —— 用**显示尺寸**的矩形，锚点是显示中心。
   *
   * 旧实现里角色的命中区也是矩形（见 `CharacterSprite` 的 `setInteractive`）。
   */
  private hitSprite(item: DrawSprite, x: number, y: number): boolean {
    const originX = item.originX ?? 0.5;
    const originY = item.originY ?? 0.5;
    const left = item.x - item.width * originX;
    const top = item.y - item.height * originY;
    return (
      x >= left &&
      x <= left + item.width &&
      y >= top &&
      y <= top + item.height
    );
  }

  /* ── 贴图加载 ────────────────────────────────────────────── */

  /**
   * 确保某张贴图已加载 —— 没有就发起加载。
   *
   * **加载是异步的**：第一次渲染时图还没到，画面上就是空的；
   * 图到了之后会调 `onTextureLoaded`（由外部接上「重画一帧」的钩子）。
   */
  private ensureTexture(source: string, spec: TextureSpec | undefined): void {
    if (this.textures.has(source)) return;
    if (this.pending.has(source)) return;

    const resolved = spec ?? this.resolveSpec(source);
    if (!resolved) return;

    const promise = this.loadImage(resolved.url)
      .then(({ image, width, height }) => {
        const frames =
          resolved.frameWidth === undefined
            ? undefined
            : buildSpriteSheetFrames(
                width,
                height,
                resolved.frameWidth,
                resolved.frameHeight ?? resolved.frameWidth,
              );
        this.textures.set(source, { image, width, height, frames });
        this.onTextureLoaded?.();
      })
      .catch(() => {
        // 加载失败就放弃 —— 下次 render 还会再试。
        this.pending.delete(source);
      });

    this.pending.set(source, promise);
    promise.then(() => this.pending.delete(source));
  }

  /** 贴图来源表里没有这个 key 时，按默认规则猜一个。 */
  private resolveSpec(source: string): TextureSpec | undefined {
    const known = this.textureSources[source];
    if (known) return known;
    // 角色贴图的 key 是角色 id（`char_xxx`），默认按约定拼路径。
    if (source.startsWith("char_")) {
      return {
        url: `/assets/characters/${source}/spritesheet.png`,
        frameWidth: 170,
        frameHeight: 204,
      };
    }
    return undefined;
  }

  /* ── 文字测量 ────────────────────────────────────────────── */

  /**
   * 量一段文字 —— 顺便算出行高和基线偏移。
   *
   * ## 为什么要一个**固定的**测试串
   *
   * Phaser 的 `Text` 用一个**固定的测试串**（`'|MÃ‰qgy'`）量出字体的
   * ascent / descent，然后**每一行**都用这个值算基线。
   *
   * 为什么不按实际文字量？因为按实际文字量的话，
   * 「你好」和「Ag」这两行的基线会不一样 —— 文字上下跳。
   *
   * Phaser 用固定串就是为了消掉这个跳动。这里照抄。
   */
  private measureText(item: DrawText): {
    width: number;
    height: number;
    lineHeight: number;
    ascent: number;
  } {
    const ctx = this.ctx;
    if (!ctx) return { width: 0, height: 0, lineHeight: 0, ascent: 0 };

    ctx.save();
    ctx.font = item.font;
    const metrics = ctx.measureText(item.content);
    const fontMetrics = ctx.measureText(PHASER_TEST_STRING);
    ctx.restore();

    // 行高 —— 用**测试串**的 ascent + descent（跟 Phaser 一致）。
    const fontSize = parseFontSize(item.font);
    const ascent =
      fontMetrics.actualBoundingBoxAscent ??
      fontMetrics.fontBoundingBoxAscent ??
      fontSize * 0.8;
    const descent =
      fontMetrics.actualBoundingBoxDescent ??
      fontMetrics.fontBoundingBoxDescent ??
      fontSize * 0.2;

    // **描边占行高** —— 照抄 Phaser 的 `GetTextSize`：
    //
    // ```
    // var lineHeight = size.fontSize + style.strokeThickness;
    // ```
    //
    // `size.fontSize` 是 `ascent + descent`（Phaser 的 `MeasureText`）。
    // 描边是往外画的，所以每一行都要多让出描边粗细 ——
    // 不算它，多行文字的第二行会**压**在第一行上。
    const lineHeight = ascent + descent + (item.strokeThickness ?? 0);

    return {
      width: metrics.width,
      height: ascent + descent,
      lineHeight,
      ascent,
    };
  }

  /* ── 临时画布 ────────────────────────────────────────────── */

  private scratch = new Map<string, SurfaceCanvas>();

  /** 拿一张（按尺寸缓存的）临时画布 —— 翻转和染色都用它。 */
  private getScratchCanvas(width: number, height: number): SurfaceCanvas {
    const w = Math.max(1, Math.ceil(width));
    const h = Math.max(1, Math.ceil(height));
    const key = `${w}x${h}`;
    const existing = this.scratch.get(key);
    if (existing) return existing;

    const canvas = this.createCanvas(w, h);
    this.scratch.set(key, canvas);
    return canvas;
  }
}

/* ── 工具函数 ────────────────────────────────────────────────── */

/**
 * Phaser 量字体用的固定测试串。
 *
 * **逐字取自** `Phaser.GameObjects.TextStyle` 的 `testString` 默认值：
 * `"|MÃ‰qgy"`。
 *
 * 里面刻意混了竖线、大写 M、带重音符的 E、小写 q/g/y ——
 * 覆盖了「高字符 + 带字形变化」的情况，量出来的 ascent/descent 更接近真实。
 *
 * 注意 `Ã‰` 是 **U+00C3 U+2030** 两个码位（不是单个 `É`）——
 * 抄错一个码位，量出来的行高就不一样。
 */
const PHASER_TEST_STRING = "|MÃ‰qgy";

/**
 * 折行 —— 照抄 Phaser 的 `useAdvancedWrap` 语义。
 *
 * 规则：**按词断行**，词太长才硬切。
 */
function wrapText(
  ctx: Surface2D,
  text: string,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (ctx.measureText(paragraph).width <= maxWidth) {
      lines.push(paragraph);
      continue;
    }
    let current = "";
    for (const word of paragraph.split(" ")) {
      const candidate = current ? `${current} ${word}` : word;
      if (ctx.measureText(candidate).width <= maxWidth) {
        current = candidate;
        continue;
      }
      if (current) lines.push(current);
      if (ctx.measureText(word).width <= maxWidth) {
        current = word;
        continue;
      }
      // 单个词就超宽 —— 硬切。
      let chunk = "";
      for (const char of word) {
        if (ctx.measureText(chunk + char).width > maxWidth && chunk) {
          lines.push(chunk);
          chunk = char;
        } else {
          chunk += char;
        }
      }
      current = chunk;
    }
    if (current) lines.push(current);
  }
  return lines;
}

/** 从 CSS `font` 简写里抠出字号（px）。 */
function parseFontSize(font: string): number {
  const match = /(\d+(?:\.\d+)?)px/.exec(font);
  return match ? Number(match[1]) : 16;
}

/** 点到矩形某个角的距离。 */
function distToCorner(x: number, y: number, cx: number, cy: number): number {
  const dx = x - cx;
  const dy = y - cy;
  return Math.sqrt(dx * dx + dy * dy);
}

/** 图片的原始宽（能拿就拿，拿不到退回 0）。 */
function sourceWidth(source: CanvasImageSource): number {
  const image = source as { width?: number; naturalWidth?: number };
  return image.naturalWidth ?? image.width ?? 0;
}

/** 图片的原始高。 */
function sourceHeight(source: CanvasImageSource): number {
  const image = source as { height?: number; naturalHeight?: number };
  return image.naturalHeight ?? image.height ?? 0;
}

/** 默认的画布工厂 —— 用浏览器的 `document`。 */
const defaultCanvasFactory: CanvasFactory = (width, height) => {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas as unknown as SurfaceCanvas;
};
