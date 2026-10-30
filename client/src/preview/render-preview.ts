/**
 * 预览台 —— 阶段 8.2 的**浏览器验收**页。
 *
 * ## 它干什么
 *
 * 把新的 `Canvas2DSceneRenderer` + `DomOverlayRenderer` 挂到一个真实世界上：
 *
 * - 从 `/assets/map/06-final.tmj` 读地图
 * - 从 `/assets/map/06-background.png` 读底图
 * - 从 `/api/world/info` 读点位
 * - 从 `/api/characters` 读角色
 * - 从 `/assets/characters/{id}/spritesheet.png` 读角色贴图
 *
 * 然后把画面**真的画出来**。
 *
 * ## 为什么要有这个
 *
 * 阶段 8.2 的验收判据是「地图/角色/气泡与现在**视觉一致**」。
 * A/B 冒烟（`scripts/renderer-smoke.mjs`) 比的是**几何**——
 * 坐标、尺寸、颜色逐点相等。
 *
 * 但「几何一样」不等于「画面一样」：
 *
 * - 贴图加载失败 → 角色不画（几何对，画面空）
 * - DPR 处理错了 → 画面糊
 * - 图层顺序错了 → 角色被盖住
 * - DOM 覆盖层没挂上 → 名牌不见
 *
 * 这些**只有真跑起来才看得见**。
 *
 * ## 怎么验（重要）
 *
 * **截图抓不到 canvas。** canvas 的合成层不在截图里 ——
 * 判「画出来了」不能靠截图，要靠：
 *
 * 1. `drawImage` 读像素 —— 非透明像素数 > 0
 * 2. DOM 覆盖层 —— 名牌元素的个数和内容
 * 3. console 无报错
 *
 * 页面上会把这些数字显示出来（`window.__previewStats`）。
 *
 * ## 用法
 *
 *     npm run dev:server   # 3100
 *     npm run dev:client   # 3200
 *     # 打开 http://localhost:3200/preview/
 */

import {
  Canvas2DSceneRenderer,
  DomOverlayRenderer,
  MapManager,
  buildRenderScene,
  createCharacterDisplayMetrics,
} from "@own-world/client-core";
import type {
  CameraState,
  CharacterRenderState,
  DialogueBubbleState,
} from "@own-world/client-core";

/* ── DOM 骨架 ────────────────────────────────────────────────── */

const root = document.getElementById("preview-root")!;
const stage = document.createElement("div");
stage.id = "stage";
root.appendChild(stage);

const labelRoot = document.createElement("div");
labelRoot.id = "label-root";
root.appendChild(labelRoot);

const stats = document.createElement("pre");
stats.id = "stats";
root.appendChild(stats);

/* ── 统计（验收靠它，不靠截图）─────────────────────────────── */

/** 各种「画出来了」的证据。 */
const previewStats = {
  error: null as string | null,
  background: { loaded: false, nonTransparentPixels: 0 },
  characters: { total: 0, spritesDrawn: 0, spritesMissing: 0 },
  overlays: { nameplates: 0, bubbles: 0 },
  lastFrameMs: 0,
};
(window as unknown as Record<string, unknown>).__previewStats = previewStats;

/** 统计画布上的非透明像素 —— canvas 真的画了东西的证据。 */
function countNonTransparentPixels(canvas: HTMLCanvasElement): number {
  const ctx = canvas.getContext("2d");
  if (!ctx) return 0;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let count = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 0) count++;
  }
  return count;
}

/* ── 相机 ────────────────────────────────────────────────────── */

/** 顶栏高度 —— 跟 `client/index.html` 的 `--top-ui-offset` 一致。 */
const TOP_UI_OFFSET = 52;
/** 相机边缘留白 —— 跟旧 `CameraController.CAMERA_EDGE_PADDING_PX` 一致。 */
const CAMERA_EDGE_PADDING_PX = 160;

/**
 * 造一台**跟旧 Phaser 实现一模一样**的相机。
 *
 * ## 为什么不能直接写 `scrollX = 地图中心`
 *
 * 契约里的 `scrollX/scrollY` 是**视口左上角**的世界坐标
 * （对应 Phaser 的 `worldView.x`），而 Phaser 自己的 `scrollX`
 * 是「相机中心减去视口一半」—— 两者差一个 `originX * width`。
 *
 * 更要紧的是 Phaser 在这条链路上**取整了两次**：
 *
 * - `centerOn(x)` → `scrollX = x - width * 0.5`（不取整）
 * - `clampX()` → 边界裁剪（可能取整到 `bounds.x`）
 * - `preRender()` → `worldView.x = floor(midPoint - displayWidth/2 + 0.5)`
 *
 * DOM 覆盖层（名牌/气泡）用的是 `worldView.x`，
 * canvas 用的却是 `camera.matrix` —— 两者之间还差一个
 * `floor(x + originX + 0.5) - originX * zoom` 的平移。
 *
 * 契约把「谁来取整」留给渲染实现 —— 所以这里**照抄 Phaser 的每一步**，
 * 把最终结果折算成契约的 `scrollX`（视口左上角）。
 */
function buildLegacyCamera(mapWidth: number, mapHeight: number): CameraState {
  // 视口 —— 跟旧实现一样，画布在顶栏**下面**。
  const stageRect = stage.getBoundingClientRect();
  const viewportWidth = stageRect.width || window.innerWidth;
  const viewportHeight = stageRect.height || window.innerHeight - TOP_UI_OFFSET;

  // cover zoom —— 照抄旧 `CameraController.getCoverZoom()`：
  // 地图**盖满**视口，取两轴里更大的那个缩放比。
  const zoom = Math.max(viewportWidth / mapWidth, viewportHeight / mapHeight);

  // `centerOn(地图中心)` —— Phaser `BaseCamera.centerOnX/Y`：
  //   scrollX = x - width * 0.5
  // 然后被 `clampX/clampY` 按边界裁一次。
  //
  // 边界 —— 照抄旧 `CameraController.applyViewportConstraints()`：
  //   extraX = max(0, 视口宽/zoom - 地图宽)
  //   paddingX = min(160, max(48, 地图宽 * 0.08))
  const displayWidth = viewportWidth / zoom;
  const displayHeight = viewportHeight / zoom;
  const extraX = Math.max(0, displayWidth - mapWidth);
  const extraY = Math.max(0, displayHeight - mapHeight);
  const paddingX = Math.min(
    CAMERA_EDGE_PADDING_PX,
    Math.max(48, mapWidth * 0.08),
  );
  const paddingY = Math.min(
    CAMERA_EDGE_PADDING_PX,
    Math.max(48, mapHeight * 0.08),
  );
  const bounds = {
    x: -extraX / 2 - paddingX,
    y: -extraY / 2 - paddingY,
    width: mapWidth + extraX + paddingX * 2,
    height: mapHeight + extraY + paddingY * 2,
  };

  // Phaser `BaseCamera.clampX/clampY`（不取整，只是裁到边界）。
  const clampX = (x: number) => {
    const bx = bounds.x + (displayWidth - viewportWidth) / 2;
    const bw = Math.max(bx, bx + bounds.width - displayWidth);
    return x < bx ? bx : x > bw ? bw : x;
  };
  const clampY = (y: number) => {
    const by = bounds.y + (displayHeight - viewportHeight) / 2;
    const bh = Math.max(by, by + bounds.height - displayHeight);
    return y < by ? by : y > bh ? bh : y;
  };

  const scrollX = clampX(mapWidth / 2 - viewportWidth / 2);
  const scrollY = clampY(mapHeight / 2 - viewportHeight / 2);

  // `worldView` —— Phaser `Camera.preRender()`：
  //   midPoint = scroll + width * 0.5
  //   displayWidth = floor(width / zoom + 0.5)
  //   worldView.x = floor(midPoint - displayWidth / 2 + 0.5)
  const midX = scrollX + viewportWidth * 0.5;
  const midY = scrollY + viewportHeight * 0.5;
  const roundedDisplayWidth = Math.floor(viewportWidth / zoom + 0.5);
  const roundedDisplayHeight = Math.floor(viewportHeight / zoom + 0.5);
  const worldViewX = Math.floor(midX - roundedDisplayWidth / 2 + 0.5);
  const worldViewY = Math.floor(midY - roundedDisplayHeight / 2 + 0.5);

  // 契约的 `scrollX` = 视口左上角的世界坐标 = `worldView.x`。
  return {
    scrollX: worldViewX,
    scrollY: worldViewY,
    zoom,
    viewportX: 0,
    viewportY: 0,
    viewportWidth,
    viewportHeight,
    mapWidth,
    mapHeight,
  };
}

/* ── 主流程 ──────────────────────────────────────────────────── */

/**
 * 加载一张图片 —— 用 `onload`/`onerror`，**不**用 `decode()`。
 *
 * `decode()` 对没挂进 DOM 的图片不保证 settle（后台标签页里直接挂死），
 * `onload` 一定会来（成功或失败都来）。
 */
function loadImage(src: string, timeoutMs = 10_000): Promise<HTMLImageElement> {
  return new Promise((resolve) => {
    const img = new Image();
    const done = () => resolve(img);
    img.onload = done;
    img.onerror = done;
    setTimeout(done, timeoutMs);
    img.src = src;
  });
}

async function main() {
  const renderer = new Canvas2DSceneRenderer({
    // 底图的 texture key —— 旧实现里 Phaser 把它叫 "world-base"。
    // 契约里的 `source` 是不透明字符串，渲染实现自己翻译成 URL。
    textureSources: {
      "world-base": { url: "/assets/map/06-background.png" },
    },
  });
  const overlays = new DomOverlayRenderer({
    displayMetrics: createCharacterDisplayMetrics(8192, 4608),
  });

  overlays.mount(labelRoot);
  renderer.mount(stage);

  /**
   * 文字测量用的离屏画布。
   *
   * 渲染实现自己有字体引擎，但**契约层**要尺寸（带底色的标签）。
   * 这里用同一个字体量 —— 量的结果跟渲染器画出来的一致。
   */
  const measureCanvas = document.createElement("canvas");
  const measureCtx = measureCanvas.getContext("2d")!;
  const measureText = (text: string, font: string) => {
    const size = /(\d+(?:\.\d+)?)px/.exec(font);
    const fontSize = size ? Number(size[1]) : 16;
    measureCtx.save();
    measureCtx.font = font;
    const m = measureCtx.measureText(text);
    measureCtx.restore();
    return {
      width: m.width,
      height:
        (m.actualBoundingBoxAscent ?? fontSize * 0.8) +
        (m.actualBoundingBoxDescent ?? fontSize * 0.2),
    };
  };

  /* ── 读数据 ──────────────────────────────────────────────── */

  const [tmj, worldInfo, characters] = await Promise.all([
    fetch("/assets/map/06-final.tmj").then((r) => r.json()),
    fetch("/api/world/info").then((r) => r.json()),
    fetch("/api/characters").then((r) => r.json()),
  ]);

  const map = new MapManager();
  map.loadFromTiledJSON(tmj);
  map.setCenterLocationId(worldInfo.centerLocationId ?? "");
  map.setMainAreaPoints(worldInfo.mainAreaPoints ?? []);

  /* ── 相机 ────────────────────────────────────────────────── */

  // ⚠ 用 `onload` 而不是 `decode()`：离屏（没挂进 DOM）的图片，
  // `decode()` 在后台标签页里可能**永远不 settle** —— 会把整条
  // `main()` 挂死。加个超时兜底，不拿它当唯一信号。
  const bgImage = await loadImage("/assets/map/06-background.png");

  const mapWidth = bgImage.naturalWidth || 8192;
  const mapHeight = bgImage.naturalHeight || 576;

  const camera = buildLegacyCamera(mapWidth, mapHeight);

  /* ── 角色 ────────────────────────────────────────────────── */

  const renderCharacters: CharacterRenderState[] = characters.map(
    (c: Record<string, unknown>) => ({
      id: String(c.id),
      name: String(c.name),
      location: String(c.location),
      mainAreaPointId: (c.mainAreaPointId as string | null) ?? null,
      spriteSource: String(c.id),
      facing: "down",
      colorIndex: 0,
      action: (c.currentAction as string | null) ?? null,
      actionLabel: (c.currentActionLabel as string | null) ?? null,
    }),
  );
  previewStats.characters.total = renderCharacters.length;

  /* ── 气泡 ────────────────────────────────────────────────── */

  // 真实世界里没有正在进行的对话（气泡是**运行时**事件驱动的），
  // 所以这里**造一个**出来 —— 验收要覆盖「地图/角色/**气泡**」三样。
  //
  // 锚点不指定 → 由 builder 按「角色位置 + 头顶偏移」算，
  // 跟旧实现走的是同一条路径。
  const bubbles: DialogueBubbleState[] =
    renderCharacters.length > 0
      ? [
          {
            characterId: renderCharacters[0].id,
            content: "这灯市的夜,倒是比白日里热闹些。",
            innerMonologue: "……总觉得有人在看我。",
          },
        ]
      : [];

  /* ── 画一帧 ──────────────────────────────────────────────── */

  const draw = () => {
    const started = performance.now();

    const scene = buildRenderScene({
      map,
      camera,
      background: {
        source: "world-base",
        width: mapWidth,
        height: mapHeight,
      },
      characters: renderCharacters,
      bubbles,
      overlays: {
        walkable: false,
        regionBounds: false,
        mainAreaPoints: false,
        interactiveObjects: false,
      },
      displayMetrics: createCharacterDisplayMetrics(mapWidth, mapHeight),
      // 契约层要尺寸（带底色的标签）—— 用**同一个字体**量，
      // 量出来的跟渲染器画出来的一致。
      measureText,
    });

    renderer.render(scene);
    overlays.render(scene.overlays);

    previewStats.lastFrameMs = Math.round(performance.now() - started);

    // 统计画布上的非透明像素。
    const canvas = stage.querySelector("canvas") as HTMLCanvasElement | null;
    if (canvas) {
      previewStats.background.nonTransparentPixels = countNonTransparentPixels(
        canvas,
      );
    }
    previewStats.overlays.nameplates = labelRoot.querySelectorAll(
      ".character-label",
    ).length;
    previewStats.overlays.bubbles = labelRoot.querySelectorAll(
      ".character-dialogue-bubble",
    ).length;

    stats.textContent = JSON.stringify(previewStats, null, 2);
  };

  // 贴图是**异步**加载的 —— 每加载完一张就重画一帧。
  renderer.onTextureLoaded = () => draw();

  const resize = () => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    renderer.resize(width, height);
    camera.viewportWidth = width;
    camera.viewportHeight = height;
    draw();
  };
  window.addEventListener("resize", resize);

  resize();
  draw();

  // 贴图陆续到齐 —— 每 300ms 重画一次，直到像素稳定。
  let stable = 0;
  let lastPixels = -1;
  const poll = setInterval(() => {
    const canvas = stage.querySelector("canvas") as HTMLCanvasElement | null;
    if (!canvas) return;
    const pixels = countNonTransparentPixels(canvas);
    if (pixels === lastPixels) {
      stable++;
      if (stable >= 3) {
        clearInterval(poll);
        previewStats.characters.spritesDrawn = pixels;
        stats.textContent = JSON.stringify(previewStats, null, 2);
      }
    } else {
      stable = 0;
      lastPixels = pixels;
    }
  }, 300);
}

main().catch((error) => {
  previewStats.error = String(error?.stack ?? error);
  stats.textContent = JSON.stringify(previewStats, null, 2);
  console.error("[preview] 崩了：", error);
});
