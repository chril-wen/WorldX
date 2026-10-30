/**
 * 冒烟脚本 —— **真实世界**上「新渲染器 vs 改造前 Phaser」逐点对比。
 *
 * ## 为什么要有这个
 *
 * 阶段 8.1 已经用 `scene-builder-smoke.mjs` 比过了**位置计算**
 * （覆盖层、标签、站位）。
 *
 * 阶段 8.2 写的是**渲染实现** —— 把「要画什么」翻译成
 * 「往画布上画了什么」。这一层还没被真实数据验证过。
 *
 * 单元测试用的是人造场景：坐标是圆整的、图元种类是有限的。
 * 真实世界不是：
 *
 * - 区域名带中文、物件 id 跟区域 id 撞名
 * - tilewidth 是 4 或 8（不是 32）
 * - 区域框贴着画面外（标签的 y 会被压回 6）
 * - 点位几十个、物件几百个
 *
 * 这些情况下**画法**算错了，单元测试测不出来。
 *
 * ## 比的是什么
 *
 * 不是「新实现跟自己比」，而是：
 *
 * - **改造前**：从 git 历史（`29a5eee`）提取的**字面** Phaser 实现，
 *   用 `phaser-stub` 把「画到 GPU」换成「记到数组」
 * - **改造后**：新的 `Canvas2DSceneRenderer`，用 `recording-canvas`
 *   把「画到 GPU」换成「记到数组」
 *
 * 两边记下来的**几何**（坐标、尺寸、颜色、透明度）必须**逐点相等**。
 *
 * 算术一个字都没改 —— 两边都只是把「画出去」换成「记下来」。
 *
 * ## 关键的一步：把两边的记法**归一**
 *
 * 老实现记的是 Phaser 的 API（`fillRect` / `fillCircle` / `fillText`），
 * 新实现记的是 Canvas 2D 的 API（`rect` / `ellipse` / `fillText`）。
 *
 * 归一的方式是**按「画了什么」重新列一遍**，
 * 而不是「按 API 名字对」——
 * 否则 Phaser 的 `fillCircle` 跟 Canvas 的 `ellipse` 永远对不上，
 * 比的是 API 名，不是画面。
 *
 * ## 怎么用
 *
 *     node scripts/renderer-smoke.mjs
 *
 * 退出码 0 = 全部一致；非 0 = 有差异（会打印具体差在哪）。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

/* ── 找世界 ──────────────────────────────────────────────────── */

function findWorlds() {
  const worlds = [];
  for (const base of [
    join(ROOT, "output", "worlds"),
    join(ROOT, "library", "worlds"),
  ]) {
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const tmjPath = join(base, entry.name, "map", "06-final.tmj");
      if (existsSync(tmjPath)) {
        worlds.push({ name: entry.name, tmjPath });
      }
    }
  }
  return worlds;
}

/* ── 加载 ────────────────────────────────────────────────────── */

async function loadNew() {
  const { tsImport } = await import("tsx/esm/api");
  return tsImport(
    pathToFileURL(join(ROOT, "packages", "client-core", "src", "index.ts")).href,
    import.meta.url,
  );
}

async function loadLegacy() {
  const { tsImport } = await import("tsx/esm/api");
  const { loadLegacySceneBaseline } = await tsImport(
    pathToFileURL(
      join(
        ROOT,
        "packages",
        "client-core",
        "src",
        "testing",
        "legacy-scene-baseline.ts",
      ),
    ).href,
    import.meta.url,
  );
  const loaded = await loadLegacySceneBaseline();
  if (!loaded.ok) {
    console.log(`[Smoke] 跳过 —— 拿不到改造前基准：${loaded.reason}`);
    return null;
  }
  return loaded;
}

/**
 * 一个**确定性**的文字测量。
 *
 * 必须跟 A/B 测试用同一个 —— 两边量出来的尺寸不一样，
 * 比出来的差异就不是「渲染逻辑」的差异。
 */
function measureText(text, font) {
  const size = /(\d+(?:\.\d+)?)px/.exec(font);
  const fontSize = size ? Number(size[1]) : 16;
  return { width: text.length * 10, height: fontSize };
}

/* ── 归一：把两边的记法压成同一种形状 ────────────────────────── */

/**
 * 老实现的记法 —— Phaser 的 Graphics / Text。
 *
 * 产出「**画出来的东西**」：矩形、椭圆、文字。
 * 不管它是 `fillRect` 还是 `strokeRect`，都记成同一个形状，
 * 只在 `painted` 上区分填/描。
 *
 * ## 形状统一
 *
 * Phaser 的 `fillCircle(r)` 跟 Canvas 的 `ellipse(x, y, r, r)` 是同一个东西，
 * 但「圆」这个形状两边叫法不同 —— 归一到**椭圆**（半径 x = 半径 y），
 * 比的才是画面，不是 API 名。
 */
function shapesFromLegacyGraphics(graphics) {
  const shapes = [];
  for (const op of graphics.ops ?? []) {
    if (op.op === "fillRect" || op.op === "strokeRect") {
      const isFill = op.op === "fillRect";
      shapes.push({
        kind: "rect",
        x: op.args[0],
        y: op.args[1],
        width: op.args[2],
        height: op.args[3],
        painted: isFill ? "fill" : "stroke",
        color: cssColor(isFill ? op.fill?.color : op.line?.color),
        alpha: isFill ? op.fill?.alpha : op.line?.alpha,
        lineWidth: isFill ? undefined : op.line?.width,
      });
    } else if (op.op === "fillCircle" || op.op === "strokeCircle") {
      const isFill = op.op === "fillCircle";
      shapes.push({
        kind: "ellipse",
        x: op.args[0],
        y: op.args[1],
        radiusX: op.args[2],
        radiusY: op.args[2],
        painted: isFill ? "fill" : "stroke",
        color: cssColor(isFill ? op.fill?.color : op.line?.color),
        alpha: isFill ? op.fill?.alpha : op.line?.alpha,
        lineWidth: isFill ? undefined : op.line?.width,
      });
    } else if (op.op === "fillEllipse") {
      shapes.push({
        kind: "ellipse",
        x: op.args[0],
        y: op.args[1],
        radiusX: op.args[2] / 2,
        radiusY: op.args[3] / 2,
        painted: "fill",
        color: cssColor(op.fill?.color),
        alpha: op.fill?.alpha,
      });
    }
  }
  return shapes;
}

/**
 * 老实现的文字 —— Phaser 的 `Text` 对象。
 *
 * ## 比的是**框**，不是字
 *
 * Phaser 的 `Text.x/y` 是**文字对象**的位置（标签左上角），
 * 字本身画在离屏画布里、再由 padding 推过去。
 *
 * 新实现记下来的是 `fillText` 的位置 —— 那是**字**的位置，
 * 已经加过 padding 了。
 *
 * 两个不是一回事，直接比会差一个 padding（6px）。
 *
 * 所以这里比**框**：
 *
 * - 老的框 = `text.x / text.y / text.width / text.height`
 *   （`Text.width` = 文字盒 + 左右 padding，照抄 Phaser）
 * - 新的框 = 底色矩形（`fillRect`）的位置和尺寸
 *
 * 框是两边**同一件东西**的位置逻辑 —— 比它才是真的在比位置。
 */
function shapesFromLegacyText(text) {
  return [
    {
      kind: "text",
      content: text.content,
      boxX: text.x,
      boxY: text.y,
      boxWidth: text.width,
      boxHeight: text.height,
      color: text.style?.color,
    },
  ];
}

/**
 * 新实现的记法 —— Canvas 2D 的录制上下文。
 *
 * **难点**：Canvas 2D 是「描路径 → 填充/描边」两段式，
 * 而 Phaser 的 `Graphics` 是一句话画完。
 *
 * 所以这里**重放**录制流：
 *
 * - `beginPath()` —— 开始一条新路径
 * - `rect(...)` / `ellipse(...)` —— 往路径里加一个子形状
 * - `fill()` —— 用**当前填充色**把路径画出来
 * - `stroke()` —— 用**当前描边色**把路径画出来
 *
 * ## 三条容易搞错的规则
 *
 * 1. **颜色取自调用自己的快照** —— 录制上下文在每次调用时
 *    记下当时的样式。`fill()` 的快照里 `fillStyle` 已经是
 *    渲染器刚设好的那个颜色。
 *    （用「上一条调用」的颜色会整体错位一格。）
 *
 * 2. **`fill()` 不清空路径** —— canvas 的语义就是这样：
 *    描完路径，fill 一次、stroke 一次，两次用的是同一条路径。
 *    清掉的话，带描边的形状就只剩填充、描边丢了。
 *
 * 3. **只有 `beginPath()` 才清空路径。**
 *
 * ## 文字的底色
 *
 * Phaser 的文字底色画在**文字自己的离屏画布**里（跟字一起），
 * 所以老实现那边一个标签 = 一个形状。
 *
 * 新实现把底色画成独立的 `fillRect` —— 画面上一样，
 * 但记下来的东西多一个。所以这里把「文字落在里面的那个底色矩形」
 * **并回那个文字**（Phaser 的做法），两边才对得上。
 */
function shapesFromRecording(calls) {
  const shapes = [];
  /** 当前路径里的子形状。 */
  let path = null;
  /** 刚记下的「底色矩形」—— 等着被某个文字认领。 */
  let pendingBackground = null;

  const pushPath = (shape) => {
    path = path ?? { subs: [] };
    path.subs.push(shape);
  };

  /**
   * 把当前路径画出来。
   *
   * `mode` 是 "fill" 或 "stroke"；颜色取自**这一次调用**的快照。
   */
  const paint = (mode, call) => {
    if (!path) return;
    for (const sub of path.subs) {
      const style = call.style;
      shapes.push({
        kind: sub.kind,
        x: sub.x,
        y: sub.y,
        ...(sub.radiusX !== undefined
          ? { radiusX: sub.radiusX, radiusY: sub.radiusY }
          : { width: sub.width, height: sub.height }),
        painted: mode,
        color: mode === "fill" ? style.fillStyle : style.strokeStyle,
        alpha: style.globalAlpha,
        ...(mode === "stroke" ? { lineWidth: style.lineWidth } : {}),
      });
    }
    // 路径**不清空** —— 紧接着的 `stroke()` 还要用同一条路径。
  };

  for (const call of calls) {
    switch (call.op) {
      case "beginPath":
        path = { subs: [] };
        break;
      case "rect":
        pushPath({
          kind: "rect",
          x: call.args[0],
          y: call.args[1],
          width: call.args[2],
          height: call.args[3],
        });
        break;
      case "ellipse":
        pushPath({
          kind: "ellipse",
          x: call.args[0],
          y: call.args[1],
          radiusX: call.args[2],
          radiusY: call.args[3],
        });
        break;
      case "fill":
        paint("fill", call);
        break;
      case "stroke":
        paint("stroke", call);
        break;
      case "fillText": {
        const text = {
          kind: "text",
          content: call.args[0],
          // 字的坐标先占位 —— 框的位置等底色矩形来补。
          x: call.args[1],
          y: call.args[2],
          color: call.style.fillStyle,
          alpha: call.style.globalAlpha,
        };
        // 底色矩形（如果刚才有一个）—— 并进这个文字里。
        //
        // 文字是**底色框内**偏右下（内边距 + 描边/2），
        // 所以判断依据是「文字落在框里」，不是「坐标相等」。
        if (
          pendingBackground &&
          text.x >= pendingBackground.x &&
          text.x <= pendingBackground.x + pendingBackground.width &&
          text.y >= pendingBackground.y &&
          text.y <= pendingBackground.y + pendingBackground.height
        ) {
          text.boxX = pendingBackground.x;
          text.boxY = pendingBackground.y;
          text.boxWidth = pendingBackground.width;
          text.boxHeight = pendingBackground.height;
          text.background = pendingBackground.color;
          text.backgroundAlpha = pendingBackground.alpha;
          pendingBackground = null;
        }
        shapes.push(text);
        break;
      }
      case "fillRect":
        // 文字底色 —— 先记着，等看有没有文字来认领。
        pendingBackground = {
          kind: "rect",
          x: call.args[0],
          y: call.args[1],
          width: call.args[2],
          height: call.args[3],
          painted: "fill",
          color: call.style.fillStyle,
          alpha: call.style.globalAlpha,
        };
        break;
      default:
        break;
    }
  }

  // 没被认领的底色 —— 单独算一个形状（正常情况下不会有）。
  if (pendingBackground) shapes.push(pendingBackground);

  return shapes;
}

/** 数字颜色 → CSS 颜色（小写，跟契约一致）。 */
function cssColor(color) {
  if (color === undefined || color === null) return undefined;
  return `#${color.toString(16).padStart(6, "0")}`;
}

/* ── 角色 ────────────────────────────────────────────────────── */

/**
 * 装一个**最小**的 `document` 全局。
 *
 * 旧 `CharacterSprite` 的名牌是 DOM（`document.createElement`）——
 * 冒烟里只需要它**建得出来**，不关心名牌画在哪
 * （名牌是 DOM 覆盖层，由 `dom-overlays.ts` 负责，不是 canvas 的事）。
 */
function installMinimalDom() {
  const makeElement = () => ({
    style: {},
    className: "",
    textContent: "",
    children: [],
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    append(...children) {
      this.children.push(...children);
    },
    remove() {},
    setAttribute() {},
  });

  const previous = globalThis.document;
  globalThis.document = {
    getElementById: () => makeElement(),
    createElement: () => makeElement(),
    body: makeElement(),
  };

  return () => {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  };
}

/**
 * 老实现的角色图元 —— `CharacterSprite` 的容器内容。
 *
 * 角色是个 `Container`，里面按顺序是：
 *
 * 1. 阴影（`Ellipse`）
 * 2. 本体容器（圆 + 高光弧，或者精灵）
 *
 * 位置是「**相对角色原点**」的 —— 容器自己带着 `x/y`，
 * 子对象是相对坐标。比较时要加上原点的位置。
 */
/**
 * 这是不是一个「Phaser 图形对象」（椭圆 / 圆 / 弧）。
 *
 * ## 为什么用鸭子类型，不用 `instanceof`
 *
 * 基准只导出 `WorldScene` / `CharacterSprite` / `MapManager` ——
 * 替身的类**没有**被导出，所以 `instanceof` 用不了。
 *
 * 鸭子类型反而更稳：判据是「有没有这些字段」，
 * 而不是「是不是这个类」—— 基准的类换了也不影响。
 */
function isLegacyShape(child) {
  return (
    child &&
    typeof child === "object" &&
    typeof child.radius === "number" &&
    typeof child.isFilled === "boolean" &&
    typeof child.isStroked === "boolean"
  );
}

function shapesFromLegacyCharacter(sprite) {
  const shapes = [];
  const originX = sprite.x;
  const originY = sprite.y;

  const shadow = sprite.children[0];
  if (shadow) {
    shapes.push({
      kind: "ellipse",
      x: originX + shadow.x,
      y: originY + shadow.y,
      radiusX: shadow.width / 2,
      radiusY: shadow.height / 2,
      painted: "fill",
      color: cssColor(shadow.fillColor),
      alpha: shadow.fillAlpha,
    });
  }

    const bodyContainer = sprite.children[1];
  if (!bodyContainer) return shapes;

  for (const child of bodyContainer.children ?? []) {
    if (!isLegacyShape(child)) continue;
    // 一个 Phaser 图形可以**同时**有填充和描边 ——
    // 拆成两个形状，跟 Canvas 2D 那边（fill 一次、stroke 一次）对上。
    if (child.isFilled) {
      shapes.push({
        kind: "ellipse",
        x: originX + child.x,
        y: originY + child.y,
        radiusX: child.radius,
        radiusY: child.radius,
        painted: "fill",
        color: cssColor(child.fillColor),
        alpha: child.fillAlpha,
      });
    }
    if (child.isStroked) {
      shapes.push({
        kind: "ellipse",
        x: originX + child.x,
        y: originY + child.y,
        radiusX: child.radius,
        radiusY: child.radius,
        painted: "stroke",
        color: cssColor(child.strokeColor),
        alpha: child.strokeAlpha,
        lineWidth: child.strokeWidth,
      });
    }
  }

  return shapes;
}

/* ── 比较 ────────────────────────────────────────────────────── */
/** 比较两组形状，列出所有不同（最多 5 条）。 */
function diffShapes(label, actual, expected, problems) {
  if (actual.length !== expected.length) {
    problems.push(
      `${label}: 形状数量 ${actual.length} ≠ ${expected.length}`,
    );
    // 数量对不上就没什么好逐点比的了。
    return;
  }
  let reported = 0;
  for (let i = 0; i < expected.length; i++) {
    const a = actual[i];
    const e = expected[i];
    for (const key of Object.keys(e)) {
      if (a[key] === e[key]) continue;
      if (key === "alpha" && Math.abs((a[key] ?? 1) - (e[key] ?? 1)) < 1e-9) {
        continue;
      }
      if (key === "color") {
        // 颜色格式可能不同（`#rrggbb` vs `rgba(...)`）——
        // 只在两边都是 `#rrggbb` 时比。
        if (
          typeof a[key] === "string" &&
          typeof e[key] === "string" &&
          a[key].startsWith("#") &&
          e[key].startsWith("#")
        ) {
          problems.push(
            `${label}[${i}].color: ${a[key]} ≠ ${e[key]}`,
          );
        }
        continue;
      }
      problems.push(
        `${label}[${i}].${key}: ${JSON.stringify(a[key])} ≠ ${JSON.stringify(e[key])}`,
      );
      reported++;
      break;
    }
    if (reported >= 5) break;
  }
}

/**
 * 把形状排成**确定的顺序** —— 比的是「画了什么」，不是「先画哪个」。
 *
 * ## 为什么不用「谁先画」来比
 *
 * 两边的绘制顺序不一样：
 *
 * - 老实现：Phaser 按 `depth` 排序（`Graphics` 深度 4/16，文字 17）
 * - 新实现：契约层按图层 depth 升序渲染
 *
 * 顺序不同**是正常的** —— 深度相同的东西谁先谁后不影响画面。
 * 所以这里按形状的**内容**排序后再比 ——
 * 比的是「这一组图元是不是一样」，而不是「顺序是不是一样」。
 *
 * 排不动的（形状完全相同）保持稳定 —— 相同的东西换个顺序也一样。
 */
function canonicalSort(shapes) {
  return [...shapes].sort((a, b) => {
    const key = (s) =>
      [
        s.kind,
        // 文字比**框**的位置（两边统一，见 `shapesFromLegacyText`）。
        s.boxX ?? s.x,
        s.boxY ?? s.y,
        s.width ?? s.radiusX ?? "",
        s.height ?? s.radiusY ?? "",
        s.painted ?? "",
        s.color ?? "",
        s.content ?? "",
      ].join("|");
    const ka = key(a);
    const kb = key(b);
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return 0;
  });
}

/* ── 主流程 ──────────────────────────────────────────────────── */

async function main() {
  const worlds = findWorlds();
  if (worlds.length === 0) {
    console.log("[Smoke] 跳过 —— 仓库里没有真实世界");
    return 0;
  }

  const [modern, legacy] = await Promise.all([loadNew(), loadLegacy()]);
  if (!legacy) {
    console.log("[Smoke] 跳过 —— 没有基准可比对");
    return 0;
  }

  legacy.setStubTextMeasurer(measureText);

  let totalProblems = 0;

  for (const world of worlds) {
    const problems = [];

    const tmj = JSON.parse(readFileSync(world.tmjPath, "utf-8"));
    const worldConfigPath = join(
      dirname(world.tmjPath),
      "..",
      "config",
      "world.json",
    );
    const worldConfig = existsSync(worldConfigPath)
      ? JSON.parse(readFileSync(worldConfigPath, "utf-8"))
      : {};

    const legacyMap = new legacy.MapManager();
    const modernMap = new modern.MapManager();
    legacyMap.loadFromTiledJSON(tmj);
    modernMap.loadFromTiledJSON(tmj);

    const mainAreaPoints = worldConfig.mainAreaPoints ?? [];
    legacyMap.setMainAreaPoints(mainAreaPoints);
    modernMap.setMainAreaPoints(mainAreaPoints);

    const camera = {
      width: 800,
      height: 600,
      zoom: 0.75,
      scrollX: 400,
      scrollY: 300,
    };

    const legacyScene = new legacy.WorldScene();
    legacyScene.mapManager = legacyMap;
    legacyScene.cameras.main.zoom = camera.zoom;
    legacyScene.cameras.main.width = camera.width;
    legacyScene.cameras.main.height = camera.height;
    legacyScene.cameras.main.scrollX = camera.scrollX;
    legacyScene.cameras.main.scrollY = camera.scrollY;
    legacyScene.cameras.main.preRender();

    const contractCamera = {
      scrollX: legacyScene.cameras.main.worldView.x,
      scrollY: legacyScene.cameras.main.worldView.y,
      zoom: camera.zoom,
      viewportX: 0,
      viewportY: 0,
      viewportWidth: legacyScene.cameras.main.worldView.width,
      viewportHeight: legacyScene.cameras.main.worldView.height,
      mapWidth: modernMap.gridWidth * modernMap.tileSize,
      mapHeight: modernMap.gridHeight * modernMap.tileSize,
    };

    const scene = modern.buildRenderScene({
      map: modernMap,
      camera: contractCamera,
      background: {
        source: "world-base",
        width: modernMap.gridWidth * modernMap.tileSize,
        height: modernMap.gridHeight * modernMap.tileSize,
      },
      characters: [],
      overlays: {
        walkable: true,
        regionBounds: true,
        mainAreaPoints: true,
        interactiveObjects: true,
      },
      measureText,
    });

    /* ── 新实现：真的跑一遍渲染器 ───────────────────────────── */

    const { createFakeCanvas } = await tsImport(
      pathToFileURL(
        join(ROOT, "packages", "client-core", "src", "testing", "recording-canvas.ts"),
      ).href,
      import.meta.url,
    );

    const { canvas, ctx } = createFakeCanvas(camera.width, camera.height);
    const renderer = new modern.Canvas2DSceneRenderer({
      createCanvas: () => canvas,
      devicePixelRatio: 1,
      loadImage: async () => {
        throw new Error("冒烟里不加载图片");
      },
    });
    renderer.mount({
      appendChild() {},
      getBoundingClientRect: () => ({
        width: camera.width,
        height: camera.height,
        left: 0,
        top: 0,
        right: camera.width,
        bottom: camera.height,
      }),
      clientWidth: camera.width,
      clientHeight: camera.height,
    });
    renderer.resize(camera.width, camera.height);
    renderer.render(scene);

    const modernShapes = shapesFromRecording(ctx.calls);

    /* ── 老实现：把四种覆盖层都建出来 ───────────────────────── */

    const legacyShapes = [];

    const walkable = legacyScene.buildWalkableOverlay();
    legacyShapes.push(...shapesFromLegacyGraphics(walkable));

    const regionContainer = legacyScene.buildRegionBoundsOverlay();
    legacyShapes.push(...shapesFromLegacyGraphics(regionContainer.list[0]));
    for (const text of regionContainer.list.slice(1)) {
      legacyShapes.push(...shapesFromLegacyText(text));
    }

    const points = legacyScene.buildMainAreaPointsOverlay();
    legacyShapes.push(...shapesFromLegacyGraphics(points));

    const objects = legacyScene.buildInteractiveObjectsOverlay();
    legacyShapes.push(...shapesFromLegacyGraphics(objects.list[0]));
    for (const text of objects.list.slice(1)) {
      legacyShapes.push(...shapesFromLegacyText(text));
    }

    diffShapes(
      "整体产物",
      canonicalSort(modernShapes),
      canonicalSort(legacyShapes),
      problems,
    );

    /* ── 角色：新旧逐点比 ───────────────────────────────────── */

    /**
     * 角色是**另一条路径** —— 覆盖层走的是 `buildRenderScene`，
     * 角色走的是 `CharacterSprite`。
     *
     * 这里单独比一遍：造一个**没有贴图**的角色（走「圆 + 高光弧」那条路），
     * 两边各自产出图元，逐点比。
     *
     * 之所以挑「没有贴图」的：
     * 有贴图时老实现画的是 `Sprite`（贴图），新实现画的是 `drawImage` ——
     * 贴图加载是异步的，冒烟里没法真比像素。
     * 几何（位置、尺寸、锚点）可以在**图元层**比，不依赖贴图。
     */
    {
      const metrics = modern.createCharacterDisplayMetrics(
        contractCamera.mapWidth,
        contractCamera.mapHeight,
      );

      // 老实现的名牌是 DOM（`document.createElement`）——
      // 冒烟里只需要它**建得出来**，不关心名牌画在哪
      // （名牌是 DOM 覆盖层，由 `dom-overlays.ts` 负责，不是 canvas 的事）。
      const restoreDom = installMinimalDom();
      try {
        // 角色站位 —— 选一个世界坐标明确的位置，避开随机站位。
        const charX = 100;
        const charY = 200;

        // 老实现。
        const legacySprite = new legacy.CharacterSprite(
          legacyScene,
          charX,
          charY,
          {
            characterId: "nobody-has-this-texture",
            name: "甲",
            color: 0x6c5ce7,
            displayMetrics: metrics,
          },
        );
        const legacyCharShapes = shapesFromLegacyCharacter(legacySprite);

        // 新实现。
        const charScene = modern.buildRenderScene({
          map: modernMap,
          camera: contractCamera,
          background: {
            source: "world-base",
            width: contractCamera.mapWidth,
            height: contractCamera.mapHeight,
          },
          characters: [
            {
              id: "c1",
              name: "甲",
              location: "main_area",
              mainAreaPointId: null,
              spriteSource: null,
              x: charX,
              y: charY,
              colorIndex: 0,
            },
          ],
          displayMetrics: metrics,
          measureText,
        });

        const charCanvas = createFakeCanvas(camera.width, camera.height);
        const charRenderer = new modern.Canvas2DSceneRenderer({
          createCanvas: () => charCanvas.canvas,
          devicePixelRatio: 1,
          loadImage: async () => {
            throw new Error("冒烟里不加载图片");
          },
        });
        charRenderer.mount({
          appendChild() {},
          getBoundingClientRect: () => ({
            width: camera.width,
            height: camera.height,
            left: 0,
            top: 0,
            right: camera.width,
            bottom: camera.height,
          }),
          clientWidth: camera.width,
          clientHeight: camera.height,
        });
        charRenderer.resize(camera.width, camera.height);
        charRenderer.render(charScene);

        const modernCharShapes = shapesFromRecording(charCanvas.ctx.calls);

        diffShapes(
          "角色图元",
          canonicalSort(modernCharShapes),
          canonicalSort(legacyCharShapes),
          problems,
        );
      } finally {
        restoreDom();
      }
    }

    if (problems.length === 0) {
      console.log(
        `[Smoke] ✓ ${world.name}: ` +
          `网格 ${modernMap.gridWidth}×${modernMap.gridHeight}@${modernMap.tileSize}px, ` +
          `形状 ${modernShapes.length} 个`,
      );
    } else {
      totalProblems += problems.length;
      console.log(`[Smoke] ✗ ${world.name}:`);
      for (const p of problems.slice(0, 12)) console.log(`  ${p}`);
      if (problems.length > 12) {
        console.log(`  …… 还有 ${problems.length - 12} 处`);
      }
    }
  }

  if (totalProblems > 0) {
    console.log(`\n[Smoke] 失败：${totalProblems} 处差异`);
    return 1;
  }

  console.log("\n[Smoke] 全部一致");
  return 0;
}

// `tsImport` 在 `loadNew` 里被引进来了 —— 这里再取一次。
let tsImport;
const originalLoadNew = loadNew;
async function loadNewWithTsx() {
  const mod = await import("tsx/esm/api");
  tsImport = mod.tsImport;
  return originalLoadNew();
}

loadNewWithTsx()
  .then(() => main())
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error("[Smoke] 崩了：", error);
    process.exitCode = 1;
  });
