/**
 * Canvas 2D 渲染器的单测。
 *
 * ## 这一层在验什么
 *
 * 渲染器**不碰位置计算** —— 坐标全是 `scene-builder` 给好的。
 *
 * 所以这里验的是**渲染器自己的责任**：
 *
 * 1. **变换对不对** —— 相机变换矩阵是不是契约里的那个公式
 * 2. **图元画对没有** —— 每种图元该调哪些 2D API、参数是什么
 * 3. **命中测试对不对** —— 点到哪儿命中哪个
 * 4. **文字盒尺寸对不对** —— 描边占尺寸这条最容易走偏
 *
 * 「位置对不对」由 `scene-builder.ab.test.ts` 和
 * `scripts/scene-builder-smoke.mjs` 负责 —— 那边比的是**旧实现**。
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Canvas2DSceneRenderer } from "./canvas2d-renderer.js";
import { buildSpriteSheetFrames } from "./textures.js";
import type {
  CameraState,
  DrawItem,
  RenderScene,
} from "../render-model.js";
import { createFakeCanvas, RecordingContext } from "../../testing/recording-canvas.js";

/* ── 测试用的场景 ────────────────────────────────────────────── */

const CAMERA: CameraState = {
  scrollX: 100,
  scrollY: 200,
  zoom: 0.5,
  viewportX: 0,
  viewportY: 0,
  viewportWidth: 800,
  viewportHeight: 600,
  mapWidth: 4000,
  mapHeight: 3000,
};

function makeScene(items: DrawItem[], camera: CameraState = CAMERA): RenderScene {
  return {
    background: { source: "world-base", width: 4000, height: 3000 },
    camera,
    layers: [{ id: "test", depth: 10, items }],
    overlays: [],
  };
}

/**
 * 造一个挂好画布的渲染器。
 *
 * 画布是**记录式**的 —— 每次 2D 调用都记下来，测试逐条比。
 *
 * `contexts` 里是**所有**创建过的画布的上下文 ——
 * 第一个是主画布，后面的可能是翻转 / 染色用的临时画布。
 */
function makeRenderer(options: {
  width?: number;
  height?: number;
} = {}) {
  const width = options.width ?? 800;
  const height = options.height ?? 600;
  const contexts: RecordingContext[] = [];

  const renderer = new Canvas2DSceneRenderer({
    devicePixelRatio: 1,
    createCanvas: (w, h) => {
      const made = createFakeCanvas(w, h);
      contexts.push(made.ctx);
      return made.canvas as never;
    },
    loadImage: async () => ({
      image: { width: 4000, height: 3000 } as unknown as CanvasImageSource,
      width: 4000,
      height: 3000,
    }),
  });

  // `mount` 需要真的 DOM —— 单测里直接塞上下文。
  const container = {
    appendChild() {},
    getBoundingClientRect: () => ({ width, height }),
    clientWidth: width,
    clientHeight: height,
  } as unknown as HTMLElement;

  renderer.mount(container);
  return { renderer, ctx: contexts[0], contexts };
}

/* ── 变换 ────────────────────────────────────────────────────── */

describe("相机变换", () => {
  it("变换矩阵就是契约里的公式", () => {
    const { renderer, ctx } = makeRenderer();
    renderer.render(makeScene([]));

    // 第 0 次是「清屏用的单位阵」，第 1 次是相机变换。
    const transform = ctx.callsOf("setTransform")[1];
    // screenX = (worldX - scrollX) * zoom + viewportX
    // → setTransform(zoom, 0, 0, zoom, viewportX - scrollX*zoom, ...)
    expect(transform.args).toEqual([
      0.5,
      0,
      0,
      0.5,
      0 - 100 * 0.5,
      0 - 200 * 0.5,
    ]);
  });

  it("DPR 大于 1 时，位图放大但变换里也放大（CSS 像素下的观感不变）", () => {
    const width = 800;
    const height = 600;
    const { canvas, ctx } = createFakeCanvas(width, height);
    const renderer = new Canvas2DSceneRenderer({
      devicePixelRatio: 2,
      createCanvas: (w, h) => {
        canvas.width = w;
        canvas.height = h;
        return canvas as never;
      },
    });
    const container = {
      appendChild() {},
      getBoundingClientRect: () => ({ width, height }),
      clientWidth: width,
      clientHeight: height,
    } as unknown as HTMLElement;
    renderer.mount(container);

    renderer.render(makeScene([]));

    // 画布位图 = CSS 尺寸 × 2
    expect(canvas.width).toBe(1600);
    expect(canvas.height).toBe(1200);

    // 变换里 zoom 也要乘 2 —— 否则图会缩一半。
    const transform = ctx.callsOf("setTransform")[1];
    expect(transform.args[0]).toBe(1);
    expect(transform.args[4]).toBe((0 - 100 * 0.5) * 2);
  });
});

/* ── 图元 ────────────────────────────────────────────────────── */

describe("矩形", () => {
  it("填充和描边分开画 —— 描边在填充之后", () => {
    const { renderer, ctx } = makeRenderer();
    renderer.render(
      makeScene([
        {
          kind: "rect",
          id: "r1",
          x: 10,
          y: 20,
          width: 100,
          height: 50,
          fill: "#ff0000",
          stroke: "#00ff00",
          lineWidth: 2,
        },
      ]),
    );

    const ops = ctx.calls.map((c) => c.op);
    const fillIndex = ops.indexOf("fill");
    const strokeIndex = ops.indexOf("stroke");
    expect(fillIndex).toBeGreaterThan(-1);
    expect(strokeIndex).toBeGreaterThan(fillIndex);
  });

  it("没有圆角时用 rect", () => {
    const { renderer, ctx } = makeRenderer();
    renderer.render(
      makeScene([
        { kind: "rect", id: "r1", x: 0, y: 0, width: 10, height: 10, fill: "#fff" },
      ]),
    );
    const rect = ctx.callsOf("rect")[0];
    expect(rect.args).toEqual([0, 0, 10, 10]);
  });

  it("有圆角时用 arcTo 描出圆角路径", () => {
    const { renderer, ctx } = makeRenderer();
    renderer.render(
      makeScene([
        {
          kind: "rect",
          id: "r1",
          x: 0,
          y: 0,
          width: 100,
          height: 40,
          fill: "#fff",
          radius: 6,
        },
      ]),
    );
    expect(ctx.callsOf("arcTo").length).toBe(4);
    expect(ctx.callsOf("rect").length).toBe(0);
  });

  it("圆角半径被限幅到短边一半 —— 不会画出畸形", () => {
    const { renderer, ctx } = makeRenderer();
    renderer.render(
      makeScene([
        {
          kind: "rect",
          id: "r1",
          x: 0,
          y: 0,
          width: 20,
          height: 10,
          fill: "#fff",
          radius: 999,
        },
      ]),
    );
    // 半径限到 5（短边的一半）
    expect(ctx.callsOf("arcTo")[0].args[4]).toBe(5);
  });

  it("透明度走 globalAlpha", () => {
    const { renderer, ctx } = makeRenderer();
    renderer.render(
      makeScene([
        {
          kind: "rect",
          id: "r1",
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          fill: "#fff",
          alpha: 0.22,
        },
      ]),
    );
    const fill = ctx.callsOf("fill")[0];
    expect(fill.style.globalAlpha).toBe(0.22);
  });
});

describe("椭圆", () => {
  it("没给起止角就是整圆", () => {
    const { renderer, ctx } = makeRenderer();
    renderer.render(
      makeScene([
        {
          kind: "ellipse",
          id: "e1",
          x: 50,
          y: 60,
          radiusX: 10,
          radiusY: 20,
          fill: "#fff",
        },
      ]),
    );
    const ellipse = ctx.callsOf("ellipse")[0];
    expect(ellipse.args.slice(0, 5)).toEqual([50, 60, 10, 20, 0]);
    expect(ellipse.args[5]).toBe(0);
    expect(ellipse.args[6]).toBe(Math.PI * 2);
  });

  it("给了起止角就是弧 —— 度换算成弧度", () => {
    const { renderer, ctx } = makeRenderer();
    renderer.render(
      makeScene([
        {
          kind: "ellipse",
          id: "e1",
          x: 0,
          y: 0,
          radiusX: 5,
          radiusY: 5,
          fill: "#fff",
          arcStart: 0,
          arcEnd: 180,
        },
      ]),
    );
    const ellipse = ctx.callsOf("ellipse")[0];
    expect(ellipse.args[5]).toBe(0);
    expect(ellipse.args[6]).toBeCloseTo(Math.PI, 10);
  });
});

describe("多边形和折线", () => {
  it("多边形的顶点是相对 x/y 的偏移", () => {
    const { renderer, ctx } = makeRenderer();
    renderer.render(
      makeScene([
        {
          kind: "polygon",
          id: "p1",
          x: 100,
          y: 200,
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 5, y: 10 },
          ],
          fill: "#fff",
        },
      ]),
    );

    const moveTo = ctx.callsOf("moveTo")[0];
    expect(moveTo.args).toEqual([100, 200]);
    const lineTo = ctx.callsOf("lineTo");
    expect(lineTo[0].args).toEqual([110, 200]);
    expect(lineTo[1].args).toEqual([105, 210]);
  });

  it("折线画成一条描边路径", () => {
    const { renderer, ctx } = makeRenderer();
    renderer.render(
      makeScene([
        {
          kind: "polyline",
          id: "pl1",
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 10 },
          ],
          stroke: "#fff",
          lineWidth: 3,
        },
      ]),
    );
    expect(ctx.callsOf("moveTo")[0].args).toEqual([0, 0]);
    expect(ctx.callsOf("lineTo")[0].args).toEqual([10, 10]);
    expect(ctx.callsOf("stroke")[0].style.lineWidth).toBe(3);
  });
});

/* ── 文字 ────────────────────────────────────────────────────── */

describe("文字", () => {
  it("描边先画、填充后画 —— 描边在字底下", () => {
    const { renderer, ctx } = makeRenderer();
    renderer.render(
      makeScene([
        {
          kind: "text",
          id: "t1",
          x: 10,
          y: 20,
          content: "巷口",
          font: "14px sans-serif",
          color: "#ffe7a8",
          stroke: "#000000",
          strokeThickness: 2,
        },
      ]),
    );

    const ops = ctx.calls.map((c) => c.op);
    expect(ops.indexOf("strokeText")).toBeGreaterThan(-1);
    expect(ops.indexOf("strokeText")).toBeLessThan(ops.indexOf("fillText"));
  });

  it("文字画在 (x + 内边距 + 描边/2)", () => {
    const { renderer, ctx } = makeRenderer();
    renderer.render(
      makeScene([
        {
          kind: "text",
          id: "t1",
          x: 100,
          y: 200,
          content: "巷口",
          font: "14px sans-serif",
          color: "#fff",
          stroke: "#000",
          strokeThickness: 2,
          padding: { left: 6, right: 6, top: 3, bottom: 3 },
        },
      ]),
    );

    const fill = ctx.callsOf("fillText")[0];
    // x + padding.left + 描边/2 = 100 + 6 + 1
    expect(fill.args[1]).toBe(107);
  });

  it("有背景时铺满整个框（含内边距）", () => {
    const { renderer, ctx } = makeRenderer();
    renderer.render(
      makeScene([
        {
          kind: "text",
          id: "t1",
          x: 100,
          y: 200,
          content: "巷口",
          font: "14px sans-serif",
          color: "#fff",
          stroke: "#000",
          strokeThickness: 2,
          background: "#000000",
          backgroundAlpha: 0.65,
          padding: { left: 6, right: 6, top: 3, bottom: 3 },
          // 契约给的框尺寸 = 文字宽(20) + 描边(2) + 内边距(12) = 34
          width: 34,
          height: 28,
        },
      ]),
    );

    const bg = ctx.callsOf("fillRect")[0];
    expect(bg.args).toEqual([100, 200, 34, 28]);
    expect(bg.style.fillStyle).toBe("#000000");
    expect(bg.style.globalAlpha).toBeCloseTo(0.65, 10);
  });

  it("背景的不透明度**乘上**图元自己的不透明度", () => {
    const { renderer, ctx } = makeRenderer();
    renderer.render(
      makeScene([
        {
          kind: "text",
          id: "t1",
          x: 0,
          y: 0,
          content: "x",
          font: "14px sans-serif",
          color: "#fff",
          background: "#000",
          backgroundAlpha: 0.5,
          alpha: 0.4,
          width: 10,
          height: 10,
        },
      ]),
    );
    expect(ctx.callsOf("fillRect")[0].style.globalAlpha).toBeCloseTo(0.2, 10);
  });

  it("给了 maxWidth 就折行", () => {
    const { renderer, ctx } = makeRenderer();
    renderer.render(
      makeScene([
        {
          kind: "text",
          id: "t1",
          x: 0,
          y: 0,
          content: "aaaa bbbb cccc",
          font: "14px sans-serif",
          color: "#fff",
          maxWidth: 50,
        },
      ]),
    );
    // 每个字 10px → 一行放得下 5 个字 → 折成 3 行
    expect(ctx.callsOf("fillText").length).toBeGreaterThan(1);
  });

  it("没有 maxWidth 就**不折行**", () => {
    const { renderer, ctx } = makeRenderer();
    renderer.render(
      makeScene([
        {
          kind: "text",
          id: "t1",
          x: 0,
          y: 0,
          content: "aaaa bbbb cccc",
          font: "14px sans-serif",
          color: "#fff",
        },
      ]),
    );
    expect(ctx.callsOf("fillText").length).toBe(1);
  });

  it("基线用**固定测试串**量 —— 换文字不会让基线跳", () => {
    // Phaser 用 `"|MÃ‰qgy"` 量字体的 ascent/descent，
    // 每一行都用这个值 —— 文字换了，基线不动。
    //
    // 这里的替身对**任何**字符串都返回同样的 ascent/descent，
    // 所以要验的是「测量用的字符串是不是那个固定串」。
    const { renderer, ctx } = makeRenderer();
    const measured: string[] = [];
    const originalMeasure = ctx.measureText.bind(ctx);
    ctx.measureText = (text: string) => {
      measured.push(text);
      return originalMeasure(text);
    };

    renderer.render(
      makeScene([
        {
          kind: "text",
          id: "t1",
          x: 0,
          y: 0,
          content: "你好",
          font: "14px sans-serif",
          color: "#fff",
        },
      ]),
    );

    // 测量过两次：一次是内容，一次是固定测试串。
    expect(measured).toContain("你好");
    expect(measured).toContain("|MÃ‰qgy");
  });

  it("**描边占行高** —— 多行的第二行不会被压在第一行上", () => {
    // Phaser 的 `GetTextSize`：
    //   `var lineHeight = size.fontSize + style.strokeThickness;`
    //
    // 描边是往外画的 —— 每行都要多让出描边粗细。
    // 不算它，两行文字会叠在一起。
    const { renderer, ctx } = makeRenderer();
    renderer.render(
      makeScene([
        {
          kind: "text",
          id: "t1",
          x: 0,
          y: 0,
          content: "第一行\n第二行",
          font: "14px sans-serif",
          color: "#fff",
          stroke: "#000",
          strokeThickness: 4,
        },
      ]),
    );

    const fills = ctx.callsOf("fillText");
    expect(fills.length).toBe(2);

    // 替身的度量：ascent = lineHeight*0.8 = 16，descent = 4。
    // 字体行高 = ascent + descent = 20；加上描边 4 → 24。
    const gap = fills[1].args[2] - fills[0].args[2];
    expect(gap).toBe(24);
  });

  it("每一行的宽度**含描边** —— 居中时才不会偏半个描边", () => {
    // Phaser 的 `lineWidths[i] = ceil(描边粗细 + 文字宽)`。
    //
    // 替身每个字 10px：「ab」= 20px，描边 4 → 24。
    // 框宽 24，居中偏移 = (24 - 24) / 2 = 0。
    //
    // 如果不算描边，宽度会算成 20，偏移 = (24-20)/2 = 2 —— 偏了 2px。
    const { renderer, ctx } = makeRenderer();
    renderer.render(
      makeScene([
        {
          kind: "text",
          id: "t1",
          x: 100,
          y: 0,
          content: "ab",
          font: "14px sans-serif",
          color: "#fff",
          stroke: "#000",
          strokeThickness: 4,
          align: "center",
        },
      ]),
    );

    const fill = ctx.callsOf("fillText")[0];
    // x + padding(0) + 描边/2(2) + 居中偏移(0)
    expect(fill.args[1]).toBe(102);
  });

  it("文字位置**取整** —— 跟 Phaser 的 `autoRound` 一致", () => {
    // Phaser 的 `autoRound` 默认 `true`：
    //   `linePositionX = Math.round(linePositionX);`
    //
    // 不取整的话字会落在半像素上，浏览器抗锯齿补偿会让它看起来更粗。
    //
    // 注意 Phaser 取整的是**局部坐标**（离屏画布内的），
    // 再加上世界坐标 —— 所以小数世界坐标**不会**被拉回整数。
    const { renderer, ctx } = makeRenderer();
    renderer.render(
      makeScene([
        {
          kind: "text",
          id: "t1",
          x: 100.4,
          y: 200.6,
          content: "x",
          font: "14px sans-serif",
          color: "#fff",
        },
      ]),
    );

    const fill = ctx.callsOf("fillText")[0];
    // 局部 x = 描边/2 = 0 → round(0) = 0 → 世界 x 100.4 保持小数。
    expect(fill.args[1]).toBe(100.4);
    // 局部 y = ascent = 16 → round(16) = 16 → 世界 y 200.6 + 16。
    expect(fill.args[2]).toBe(216.6);
  });

  it("局部坐标取整、世界坐标不动 —— 小数位置不会被拉回整数", () => {
    // Phaser 把文字画在离屏 canvas 上，再把画布贴到 (x, y)。
    // 取整只发生在**画布内部** —— 画布自己的位置是不取整的。
    //
    // 这条最容易搞反：把世界坐标取整会让文字在两个世界位置之间跳。
    const { renderer, ctx } = makeRenderer();
    renderer.render(
      makeScene([
        {
          kind: "text",
          id: "t1",
          x: 100.6,
          y: 200.4,
          content: "x",
          font: "14px sans-serif",
          color: "#fff",
          stroke: "#000",
          strokeThickness: 3,
          padding: { left: 6, right: 6, top: 3, bottom: 3 },
        },
      ]),
    );

    const fill = ctx.callsOf("fillText")[0];
    // 局部 x = 描边/2 = 1.5 → round = 2 → 100.6 + 6 + 2 = 108.6
    expect(fill.args[1]).toBe(108.6);
    // 局部 y = 1.5 + ascent(16) = 17.5 → round = 18 → 200.4 + 3 + 18 = 221.4
    expect(fill.args[2]).toBe(221.4);
  });

  it("多行时框更高 —— 行高 × 行数", () => {
    // Phaser：`this.height = textSize.height + padding.top + padding.bottom`
    // 而 `textSize.height = lineHeight × 行数`。
    const { renderer, ctx } = makeRenderer();
    renderer.render(
      makeScene([
        {
          kind: "text",
          id: "t1",
          x: 0,
          y: 0,
          content: "a\nb\nc",
          font: "14px sans-serif",
          color: "#fff",
          background: "#000",
        },
      ]),
    );

    // 字体行高 20（ascent 16 + descent 4），3 行 → 60。
    const bg = ctx.callsOf("fillRect")[0];
    expect(bg.args[3]).toBe(60);
  });
});

/* ── 命中测试 ────────────────────────────────────────────────── */

describe("命中测试", () => {
  it("点中矩形返回它的 id", () => {
    const { renderer } = makeRenderer();
    renderer.render(
      makeScene([
        {
          kind: "rect",
          id: "r1",
          x: 100,
          y: 100,
          width: 50,
          height: 50,
          fill: "#fff",
        },
      ]),
    );

    // 屏幕坐标 = (世界坐标 - scroll) * zoom
    expect(renderer.hitTest((150 - 100) * 0.5, (150 - 200) * 0.5)).toBe("r1");
  });

  it("点空白返回 null", () => {
    const { renderer } = makeRenderer();
    renderer.render(
      makeScene([
        {
          kind: "rect",
          id: "r1",
          x: 100,
          y: 100,
          width: 50,
          height: 50,
          fill: "#fff",
        },
      ]),
    );
    expect(renderer.hitTest(999, 999)).toBeNull();
  });

  it("点中圆返回它的 id", () => {
    const { renderer } = makeRenderer();
    renderer.render(
      makeScene([
        {
          kind: "ellipse",
          id: "e1",
          x: 100,
          y: 100,
          radiusX: 20,
          radiusY: 20,
          fill: "#fff",
        },
      ]),
    );
    // 世界坐标 (100, 100) 对应的屏幕坐标
    expect(renderer.hitTest(0, (100 - 200) * 0.5)).toBe("e1");
    // 圆外一点 —— 不命中
    expect(renderer.hitTest((130 - 100) * 0.5, (100 - 200) * 0.5)).toBeNull();
  });

  it("圆角矩形的角上**不命中**", () => {
    const { renderer } = makeRenderer();
    renderer.render(
      makeScene([
        {
          kind: "rect",
          id: "r1",
          x: 100,
          y: 100,
          width: 100,
          height: 100,
          fill: "#fff",
          radius: 20,
        },
      ]),
    );

    // 左上角正中间 —— 圆角切掉了，不命中
    expect(renderer.hitTest((102 - 100) * 0.5, (102 - 200) * 0.5)).toBeNull();
    // 正中间 —— 命中
    expect(renderer.hitTest((150 - 100) * 0.5, (150 - 200) * 0.5)).toBe("r1");
  });

  it("上面的层先命中", () => {
    const { renderer } = makeRenderer();
    const scene: RenderScene = {
      background: { source: "world-base", width: 4000, height: 3000 },
      camera: CAMERA,
      layers: [
        {
          id: "low",
          depth: 4,
          items: [
            {
              kind: "rect",
              id: "low-rect",
              x: 100,
              y: 100,
              width: 100,
              height: 100,
              fill: "#fff",
            },
          ],
        },
        {
          id: "high",
          depth: 17,
          items: [
            {
              kind: "rect",
              id: "high-rect",
              x: 100,
              y: 100,
              width: 100,
              height: 100,
              fill: "#fff",
            },
          ],
        },
      ],
      overlays: [],
    };
    renderer.render(scene);

    expect(renderer.hitTest((150 - 100) * 0.5, (150 - 200) * 0.5)).toBe("high-rect");
  });

  it("精灵按显示尺寸的矩形命中", () => {
    const { renderer } = makeRenderer();
    renderer.render(
      makeScene([
        {
          kind: "sprite",
          id: "s1",
          x: 100,
          y: 100,
          originX: 0.5,
          originY: 0.85,
          source: "char_x",
          width: 100,
          height: 200,
        },
      ]),
    );

    // 贴图左上角 = (100 - 50, 100 - 170) = (50, -70)
    expect(renderer.hitTest((60 - 100) * 0.5, (-60 - 200) * 0.5)).toBe("s1");
    // 贴图右下角外 —— 不命中
    expect(renderer.hitTest((160 - 100) * 0.5, (-60 - 200) * 0.5)).toBeNull();
  });
});

/* ── 贴图集 ──────────────────────────────────────────────────── */

describe("贴图集切帧", () => {
  it("帧序是行优先 —— 跟 Phaser 一致", () => {
    // 1048×1048 的图，每帧 170×204 → 每行 6 帧，共 30 帧。
    const frames = buildSpriteSheetFrames(1048, 1048, 170, 204);

    expect(frames.length).toBe(30);
    // 第 0 帧：左上
    expect(frames[0]).toEqual({ x: 0, y: 0, width: 170, height: 204 });
    // 第 1 帧：同一行右移一格
    expect(frames[1]).toEqual({ x: 170, y: 0, width: 170, height: 204 });
    // 第 5 帧：这一行最后一格
    expect(frames[5].x).toBe(850);
    // 第 6 帧：换行
    expect(frames[6]).toEqual({ x: 0, y: 204, width: 170, height: 204 });
  });

  it("站桩帧（18/19/20）在第 4 行的头三格 —— 正面/背面/侧面", () => {
    const frames = buildSpriteSheetFrames(1048, 1048, 170, 204);

    // 帧 18 = 第 4 行第 1 格
    expect(frames[18]).toEqual({ x: 0, y: 612, width: 170, height: 204 });
    // 帧 19 = 第 4 行第 2 格
    expect(frames[19]).toEqual({ x: 170, y: 612, width: 170, height: 204 });
    // 帧 20 = 第 4 行第 3 格
    expect(frames[20]).toEqual({ x: 340, y: 612, width: 170, height: 204 });
  });

  it("帧数跟每行帧数、每列帧数对得上", () => {
    const frames = buildSpriteSheetFrames(1048, 1048, 170, 204);
    // 6 列 × 5 行 = 30
    expect(frames.length).toBe(6 * 5);
  });
});

/* ── 生命周期 ────────────────────────────────────────────────── */

describe("生命周期", () => {
  let renderer: Canvas2DSceneRenderer;
  let ctx: RecordingContext;

  beforeEach(() => {
    const made = makeRenderer();
    renderer = made.renderer;
    ctx = made.ctx;
  });

  it("render 之前先清屏", () => {
    renderer.render(makeScene([]));
    expect(ctx.callsOf("clearRect").length).toBe(1);
  });

  it("render 之后变换复位 —— 下次画不受影响", () => {
    renderer.render(makeScene([]));
    const transforms = ctx.callsOf("setTransform");
    // 开头设一次相机变换，结尾复位一次（外加开头清屏用的单位阵）
    expect(transforms.length).toBe(3);
    expect(transforms[1].args).toEqual([0.5, 0, 0, 0.5, -50, -100]);
    expect(transforms[2].args).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it("dispose 之后 render 不报错", () => {
    renderer.dispose();
    expect(() => renderer.render(makeScene([]))).not.toThrow();
  });
});
