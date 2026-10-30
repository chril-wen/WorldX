/**
 * 记录式 2D 上下文 —— 单测用的替身。
 *
 * ## 为什么需要它
 *
 * 渲染器要验的是「**画了什么、画在哪**」——
 * 矩形画在哪个坐标、圆画了几个、文字的基线在哪。
 *
 * 这些信息在真 canvas 上**看不到**（画完就只剩像素）。
 * 而真 canvas 在 Node 里**也不存在**（没有 DOM、没有 canvas 实现）。
 *
 * 所以这里给一个**只记录不画**的替身：
 * 每次调用都往数组里塞一条记录，测试逐条比。
 *
 * ## 它替代的是「画到 GPU」，不是「算成什么」
 *
 * 跟 A/B 基准的替身（`testing/phaser-stub.ts`）同一个思路：
 * **被检验的算术一个字都没改**，只是把「画出去」换成「记下来」。
 */

import type { Surface2D } from "../render/canvas2d/canvas2d-renderer.js";

/** 一次绘制调用的记录。 */
export interface RecordedCall {
  /** 调用名。 */
  op: string;
  /** 参数。 */
  args: unknown[];
  /** 调用时的样式。 */
  style: {
    fillStyle: string;
    strokeStyle: string;
    lineWidth: number;
    globalAlpha: number;
    font: string;
  };
}

/** 记录式上下文 —— 同时实现 `Surface2D`。 */
export class RecordingContext implements Surface2D {
  calls: RecordedCall[] = [];

  fillStyle = "#000000";
  strokeStyle = "#000000";
  lineWidth = 1;
  lineJoin = "miter";
  lineCap = "butt";
  globalAlpha = 1;
  globalCompositeOperation = "source-over";
  font = "10px sans-serif";
  textBaseline = "alphabetic";

  /**
   * 每个字宽多少像素 —— 测文字布局时好算。
   *
   * 默认 10（跟 `scene-builder.ab.test.ts` 的测量一致）。
   */
  charWidth = 10;
  /** 每个字高多少像素。 */
  lineHeight = 20;

  private record(op: string, ...args: unknown[]): void {
    this.calls.push({
      op,
      args,
      style: {
        fillStyle: this.fillStyle,
        strokeStyle: this.strokeStyle,
        lineWidth: this.lineWidth,
        globalAlpha: this.globalAlpha,
        font: this.font,
      },
    });
  }

  save() {
    this.record("save");
  }
  restore() {
    this.record("restore");
  }
  translate(x: number, y: number) {
    this.record("translate", x, y);
  }
  scale(x: number, y: number) {
    this.record("scale", x, y);
  }
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number) {
    this.record("setTransform", a, b, c, d, e, f);
  }
  clearRect(x: number, y: number, w: number, h: number) {
    this.record("clearRect", x, y, w, h);
  }
  fillRect(x: number, y: number, w: number, h: number) {
    this.record("fillRect", x, y, w, h);
  }
  strokeRect(x: number, y: number, w: number, h: number) {
    this.record("strokeRect", x, y, w, h);
  }
  beginPath() {
    this.record("beginPath");
  }
  closePath() {
    this.record("closePath");
  }
  moveTo(x: number, y: number) {
    this.record("moveTo", x, y);
  }
  lineTo(x: number, y: number) {
    this.record("lineTo", x, y);
  }
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number) {
    this.record("arcTo", x1, y1, x2, y2, r);
  }
  ellipse(
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
    startAngle: number,
    endAngle: number,
    counterclockwise?: boolean,
  ) {
    this.record(
      "ellipse",
      x,
      y,
      radiusX,
      radiusY,
      rotation,
      startAngle,
      endAngle,
      counterclockwise,
    );
  }
  fill() {
    this.record("fill");
  }
  stroke() {
    this.record("stroke");
  }
  fillText(text: string, x: number, y: number) {
    this.record("fillText", text, x, y);
  }
  strokeText(text: string, x: number, y: number) {
    this.record("strokeText", text, x, y);
  }
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
  ) {
    this.record("drawImage", image, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight);
  }
  rect(x: number, y: number, w: number, h: number) {
    this.record("rect", x, y, w, h);
  }
  measureText(text: string) {
    return {
      width: text.length * this.charWidth,
      actualBoundingBoxAscent: this.lineHeight * 0.8,
      actualBoundingBoxDescent: this.lineHeight * 0.2,
    };
  }

  /* ── 测试用的查询helper ──────────────────────────────────── */

  /** 某类调用的所有记录。 */
  callsOf(op: string): RecordedCall[] {
    return this.calls.filter((call) => call.op === op);
  }

  /** 清空记录。 */
  clear(): void {
    this.calls.length = 0;
  }
}

/**
 * 造一张假的画布 —— 上下文是记录式的。
 *
 * 返回的对象结构跟真 canvas 一致（`width` / `height` / `style` / `getContext`），
 * 所以渲染器不用知道自己在测。
 */
export function createFakeCanvas(width = 800, height = 600): {
  canvas: {
    width: number;
    height: number;
    style: { display: string; width: string; height: string };
    getContext(type: "2d"): RecordingContext | null;
  };
  ctx: RecordingContext;
} {
  const ctx = new RecordingContext();
  const canvas = {
    width,
    height,
    style: { display: "", width: "", height: "" },
    getContext(_type: "2d") {
      return ctx;
    },
  };
  return { canvas, ctx };
}
