/**
 * 渲染 A/B 像素比对 —— 阶段 8.2 的**浏览器验收**工具。
 *
 * ## 它干什么
 *
 * 在**同一个浏览器页面**里，用**同一份数据、同一台相机**画两遍：
 *
 * - 左：旧 Phaser 实现（强制用 **Canvas 渲染器**，这样能读像素）
 * - 右：新 `Canvas2DSceneRenderer`
 * - 底：逐像素差异
 *
 * 然后把差异统计出来（多少像素不一致、差异最大的地方在哪）。
 *
 * ## 为什么非得在浏览器里做
 *
 * Node 里的 A/B 冒烟（`scripts/renderer-smoke.mjs`）比的是**几何** ——
 * 坐标、尺寸、颜色逐点相等。那已经证明「新实现算的东西一样」。
 *
 * 但它证不了「**画出来一样**」：
 *
 * - 贴图加载失败 → 角色不画（几何对，画面空）
 * - DPR 处理错了 → 画面糊
 * - 图层顺序错了 → 角色被盖住
 * - 相机变换的符号错了 → 整个画面镜像/平移
 *
 * 这些**只有真跑起来才看得见**。
 *
 * ## 为什么旧实现要用 Canvas 渲染器
 *
 * 旧实现默认走 WebGL，而 WebGL 的画布**读不回像素**
 * （`preserveDrawingBuffer: false`）—— 截图也抓不到合成层。
 *
 * 强制 `Phaser.CANVAS` 之后，两边都是 2D 画布，能直接 `getImageData`。
 *
 * ## 判据
 *
 * **不是**要求逐像素完全相同 —— 抗锯齿、纹理过滤、两套渲染器的
 * 采样方式都会带来亚像素级差异。
 *
 * 判据是：
 *
 * 1. **差异像素占比很低**（通常 < 1%）
 * 2. 差异**集中在角色轮廓边缘**（采样噪声），而不是成片区域
 * 3. **没有任何一块是「整片缺失」** —— 那是真 bug（比如贴图没加载）
 *
 * 第 3 条用「差异像素的连通块大小」来判 —— 见 `diffStats()`。
 */

import Phaser from "phaser";
import {
  Canvas2DSceneRenderer,
  DomOverlayRenderer,
  MapManager,
  buildRenderScene,
  createCharacterDisplayMetrics,
  loadCharacterSpriteFrameSize,
  type CharacterRenderState,
  type CameraState,
} from "@own-world/client-core";

/* ── 页面骨架 ────────────────────────────────────────────────── */

const root = document.getElementById("ab-root")!;
const statsEl = document.getElementById("ab-stats")!;

/** 视口尺寸 —— 两边必须一模一样。 */
const VIEW_W = 800;
const VIEW_H = 600;
/** 缩放 —— 挑个非整数，逼出取整差异。 */
const ZOOM = 1.25;

/** 差异图里「明显不同」的阈值（每通道差）。 */
const DIFF_THRESHOLD = 24;

interface Stage {
  el: HTMLDivElement;
  canvas: HTMLCanvasElement;
}

/** 造一块舞台 —— **不**自带画布（画布由渲染器/Phaser 各自创建）。 */
function makeStage(top: number, left: number): Stage {
  const el = document.createElement("div");
  el.className = "ab-stage";
  el.style.top = `${top}px`;
  el.style.left = `${left}px`;
  root.appendChild(el);
  return { el, canvas: null as unknown as HTMLCanvasElement };
}

const legacyStage = makeStage(0, 0);
const newStage = makeStage(0, VIEW_W + 8);
const diffStage = makeStage(VIEW_H + 8, 0);

/* ── 统计 ────────────────────────────────────────────────────── */

const abStats = {
  error: null as string | null,
  characters: 0,
  legacyNonTransparent: 0,
  newNonTransparent: 0,
  diffPixels: 0,
  diffRatio: 0,
  maxBlock: 0,
  blocksOver100: 0,
  note: "",
};
(window as unknown as Record<string, unknown>).__abStats = abStats;

function renderStats(): void {
  statsEl.textContent = JSON.stringify(abStats, null, 2);
}

/* ── 工具 ────────────────────────────────────────────────────── */

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(img);
    img.src = src;
  });
}

function nonTransparentCount(data: Uint8ClampedArray): number {
  let n = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) n++;
  return n;
}

/**
 * 差异连通块 —— 4 连通。
 *
 * 用来区分「**亚像素噪声**」和「**整块没画出来**」：
 *
 * - 噪声 → 大量 1~4 像素的小块
 * - 真 bug → 几块几百上千像素的大块
 *
 * 只数**红色**像素（差异图里红色 = 不一致）——
 * 底图压暗后也是不透明的，别把它算进来。
 */
function diffBlocks(diff: Uint8ClampedArray, w: number, h: number): {
  count: number;
  max: number;
  over100: number;
} {
  const isDiff = (i: number) => diff[i * 4] === 255 && diff[i * 4 + 1] === 0;
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  let count = 0;
  let max = 0;
  let over100 = 0;

  for (let i = 0; i < w * h; i++) {
    if (seen[i] || !isDiff(i)) continue;
    count++;
    let size = 0;
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      size++;
      const x = p % w;
      const y = (p - x) / w;
      if (x > 0 && !seen[p - 1] && isDiff(p - 1)) {
        seen[p - 1] = 1;
        stack.push(p - 1);
      }
      if (x < w - 1 && !seen[p + 1] && isDiff(p + 1)) {
        seen[p + 1] = 1;
        stack.push(p + 1);
      }
      if (y > 0 && !seen[p - w] && isDiff(p - w)) {
        seen[p - w] = 1;
        stack.push(p - w);
      }
      if (y < h - 1 && !seen[p + w] && isDiff(p + w)) {
        seen[p + w] = 1;
        stack.push(p + w);
      }
    }
    if (size > max) max = size;
    if (size > 100) over100++;
  }

  return { count, max, over100 };
}

/* ── 旧实现（Phaser，Canvas 渲染器）──────────────────────────── */

/** 旧 Phaser 场景 —— 只画「底图 + 角色」，跟新实现对齐。 */
class LegacyScene extends Phaser.Scene {
  characterIds: string[] = [];
  placements: Array<{ id: string; x: number; y: number }> = [];
  /**
   * 每个角色的格子大小。
   *
   * ⚠ **不能写死 170×204** —— 新贴图集是 1048×1048，真格子 174×209。
   * 写死的话窗口会错位，角色的脚会跑到头顶上（两边一样错，
   * A/B 比对就发现不了）。
   */
  frameSizes: Record<string, { frameWidth: number; frameHeight: number }> = {};
  mapWidth = 0;
  mapHeight = 0;
  sprites: Phaser.GameObjects.Sprite[] = [];
  shadows: Phaser.GameObjects.Ellipse[] = [];

  /** 场景画完的信号 —— 在 `create()` 末尾 resolve。 */
  onReady: (() => void) | null = null;

  constructor() {
    super("LegacyScene");
  }

  preload(): void {
    this.load.image("world-base", "/assets/map/06-background.png");
    for (const id of this.characterIds) {
      const size = this.frameSizes[id] ?? { frameWidth: 170, frameHeight: 204 };
      this.load.spritesheet(id, `/assets/characters/${id}/spritesheet.png`, {
        frameWidth: size.frameWidth,
        frameHeight: size.frameHeight,
      });
    }
  }

  create(): void {
    const bg = this.add.image(0, 0, "world-base").setOrigin(0, 0);
    this.mapWidth = bg.width;
    this.mapHeight = bg.height;

    const metrics = createCharacterDisplayMetrics(this.mapWidth, this.mapHeight);

    for (const p of this.placements) {
      // 阴影 —— 照抄旧 `CharacterSprite.createVisuals()`。
      const shadow = this.add.ellipse(
        p.x,
        p.y + metrics.shadowOffsetY,
        metrics.shadowWidth,
        metrics.shadowHeight,
        0x000000,
        0.4,
      );
      this.shadows.push(shadow);

      // 身体 —— 照抄旧 `CharacterSprite.createSpriteBody()`。
      const sprite = this.add.sprite(p.x, p.y, p.id, 18);
      sprite.setDisplaySize(metrics.spriteWidth, metrics.spriteHeight);
      sprite.setOrigin(0.5, 0.85);
      this.sprites.push(sprite);
    }

    // 相机 —— 照抄旧 `CameraController`：cover zoom + 居中。
    const cam = this.cameras.main;
    cam.setZoom(ZOOM);
    cam.centerOn(this.mapWidth / 2, this.mapHeight / 2);

    this.onReady?.();
  }
}

/* ── 主流程 ──────────────────────────────────────────────────── */

async function main(): Promise<void> {
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

  const bgImage = await loadImage("/assets/map/06-background.png");
  const mapWidth = bgImage.naturalWidth;
  const mapHeight = bgImage.naturalHeight;

  const metrics = createCharacterDisplayMetrics(mapWidth, mapHeight);

  /* ── 站位（两边用同一份）─────────────────────────────────── */

  // 中心区域的角色按点位站，其余的随机站一个可走的点。
  const centerLocationId = map.getCenterLocationId();
  const occupants = new Map<string, string[]>();
  for (const c of characters) {
    if (c.location !== centerLocationId || !c.mainAreaPointId) continue;
    const list = occupants.get(c.mainAreaPointId) ?? [];
    list.push(c.id);
    occupants.set(c.mainAreaPointId, list);
  }

  const placements = characters.map((c: Record<string, unknown>) => {
    const id = String(c.id);
    const location = String(c.location);
    const pointId = (c.mainAreaPointId as string | null) ?? null;
    const p =
      (location === centerLocationId && pointId
        ? map.getMainAreaPlacement(pointId, id, {
            occupantIds: occupants.get(pointId) ?? [id],
          })
        : null) ??
      map.getRandomWalkablePointInLocation(location, {
        preferInset: map.isPinnedLocation(location),
      }) ??
      { x: 400, y: 300 };
    return { id, x: p.x, y: p.y };
  });

  abStats.characters = placements.length;

  /* ── 格子大小（两边共用一份）─────────────────────────────── */

  /**
   * 每个角色的贴图格子大小。
   *
   * ⚠ **必须查，不能写死** —— 新贴图集是 1048×1048，真格子 174×209。
   * 写死 170×204 会让窗口错位（脚跑到头顶上），
   * 而且**两边一样错** → A/B 比对发现不了。
   */
  const frameSizes: Record<string, { frameWidth: number; frameHeight: number }> =
    {};
  for (const c of characters) {
    const id = String(c.id);
    frameSizes[id] = await loadCharacterSpriteFrameSize(id);
  }

  /* ── 旧实现 ──────────────────────────────────────────────── */

  const legacyScene = new LegacyScene();
  legacyScene.characterIds = placements.map((p: { id: string }) => p.id);
  legacyScene.placements = placements;
  legacyScene.frameSizes = frameSizes;

  const game = new Phaser.Game({
    type: Phaser.CANVAS,
    width: VIEW_W,
    height: VIEW_H,
    parent: legacyStage.el,
    transparent: false,
    backgroundColor: "#070819",
    render: { antialias: true, roundPixels: false },
    scale: { mode: Phaser.Scale.NONE },
    scene: [legacyScene],
  });

  await new Promise<void>((resolve) => {
    legacyScene.onReady = resolve;
    // 兜底 —— 贴图加载失败时别把页面挂死。
    setTimeout(resolve, 15_000);
  });

  // 让 Phaser 把这一帧画完。
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  const legacyCam = game.scene.getScene("LegacyScene")!.cameras.main;
  // Phaser **自己**在 parent 里建了画布 —— 用它，不是我们自己那张。
  const legacyCanvas = game.canvas as HTMLCanvasElement;
  legacyStage.el.appendChild(legacyCanvas);
  const legacyCtx = legacyCanvas.getContext("2d", { willReadFrequently: true });
  const legacyPixels = legacyCtx!.getImageData(0, 0, VIEW_W, VIEW_H);

  /* ── 新实现 ──────────────────────────────────────────────── */

  /**
   * 契约相机 —— **从旧相机换算**过来。
   *
   * 两个渲染器的 `scrollX` 含义**不同**：
   *
   * - Phaser：`scrollX` = 相机中心 - 视口一半（再乘进矩阵）
   * - 契约：`scrollX` = **视口左上角**的世界坐标
   *
   * Phaser 的画布矩阵是
   * `screenX = zoom * (worldX - scrollX) + floor(x + originX + 0.5) - originX`
   * （`originX = width * 0.5`），所以换算是：
   *
   *   scrollX_契约 = scrollX_Phaser
   *                 - (floor(width/2 + 0.5) - width/2) / zoom
   */
  const originX = VIEW_W * 0.5;
  const originY = VIEW_H * 0.5;
  const camTx = Math.floor(legacyCam.x + originX + 0.5) - originX * legacyCam.zoom;
  const camTy = Math.floor(legacyCam.y + originY + 0.5) - originY * legacyCam.zoom;

  const camera: CameraState = {
    scrollX: legacyCam.scrollX - camTx / legacyCam.zoom,
    scrollY: legacyCam.scrollY - camTy / legacyCam.zoom,
    zoom: legacyCam.zoom,
    viewportX: 0,
    viewportY: 0,
    viewportWidth: VIEW_W,
    viewportHeight: VIEW_H,
    mapWidth,
    mapHeight,
  };

  const renderCharacters: CharacterRenderState[] = characters.map(
    (c: Record<string, unknown>, index: number) => {
      // ⚠ **位置必须钉死**。
      //
      // 非中心区域的角色走 `getRandomWalkablePointInLocation()` ——
      // **每次调用位置都不一样**。要是让两边各算各的，
      // 比的就是「两个随机点」，跟渲染无关了。
      const p = placements[index];
      return {
        id: String(c.id),
        name: String(c.name),
        location: String(c.location),
        mainAreaPointId: (c.mainAreaPointId as string | null) ?? null,
        spriteSource: String(c.id),
        facing: "down",
        colorIndex: 0,
        action: (c.currentAction as string | null) ?? null,
        actionLabel: (c.currentActionLabel as string | null) ?? null,
        x: p.x,
        y: p.y,
      };
    },
  );

  const renderer = new Canvas2DSceneRenderer({
    textureSources: { "world-base": { url: "/assets/map/06-background.png" } },
    devicePixelRatio: 1,
  });
  renderer.mount(newStage.el);
  renderer.resize(VIEW_W, VIEW_H);

  const overlays = new DomOverlayRenderer({ displayMetrics: metrics });
  const labelRoot = document.createElement("div");
  labelRoot.style.position = "absolute";
  labelRoot.style.top = "0";
  labelRoot.style.left = `${VIEW_W + 8}px`;
  labelRoot.style.width = `${VIEW_W}px`;
  labelRoot.style.height = `${VIEW_H}px`;
  labelRoot.style.pointerEvents = "none";
  root.appendChild(labelRoot);
  overlays.mount(labelRoot);

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

  const drawNew = (): void => {
    const scene = buildRenderScene({
      map,
      camera,
      background: { source: "world-base", width: mapWidth, height: mapHeight },
      characters: renderCharacters,
      bubbles: [],
      overlays: {
        walkable: false,
        regionBounds: false,
        mainAreaPoints: false,
        interactiveObjects: false,
      },
      displayMetrics: metrics,
      measureText,
    });
    renderer.render(scene);
    overlays.render(scene.overlays);
  };

  // 贴图是异步的 —— 等到全部到齐再比对。
  let pending = 0;
  renderer.onTextureLoaded = () => {
    pending++;
    drawNew();
  };
  drawNew();

  // 等贴图加载（最多 8 秒）。
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (pending >= placements.length) break;
  }
  drawNew();

  const newCanvas = newStage.el.querySelector("canvas") as HTMLCanvasElement;
  const newCtx = newCanvas.getContext("2d", { willReadFrequently: true });
  const newPixels = newCtx!.getImageData(0, 0, VIEW_W, VIEW_H);

  /* ── 比对 ────────────────────────────────────────────────── */

  const diffCanvas = diffStage.el.ownerDocument.createElement("canvas");
  diffCanvas.width = VIEW_W;
  diffCanvas.height = VIEW_H;
  diffStage.el.appendChild(diffCanvas);
  const diffCtx = diffCanvas.getContext("2d")!;
  const diffImage = diffCtx.createImageData(VIEW_W, VIEW_H);
  let diffPixels = 0;

  for (let i = 0; i < legacyPixels.data.length; i += 4) {
    const dr = Math.abs(legacyPixels.data[i] - newPixels.data[i]);
    const dg = Math.abs(legacyPixels.data[i + 1] - newPixels.data[i + 1]);
    const db = Math.abs(legacyPixels.data[i + 2] - newPixels.data[i + 2]);
    const da = Math.abs(legacyPixels.data[i + 3] - newPixels.data[i + 3]);
    const max = Math.max(dr, dg, db, da);

    if (max > DIFF_THRESHOLD) {
      diffPixels++;
      diffImage.data[i] = 255;
      diffImage.data[i + 1] = 0;
      diffImage.data[i + 2] = 0;
      diffImage.data[i + 3] = 255;
    } else {
      // 底图压暗，方便看差异
      const g = Math.round(
        (legacyPixels.data[i] + legacyPixels.data[i + 1] + legacyPixels.data[i + 2]) / 3 * 0.4,
      );
      diffImage.data[i] = g;
      diffImage.data[i + 1] = g;
      diffImage.data[i + 2] = g;
      diffImage.data[i + 3] = 255;
    }
  }
  diffCtx.putImageData(diffImage, 0, 0);

  const blocks = diffBlocks(diffImage.data, VIEW_W, VIEW_H);

  abStats.legacyNonTransparent = nonTransparentCount(legacyPixels.data);
  abStats.newNonTransparent = nonTransparentCount(newPixels.data);
  abStats.diffPixels = diffPixels;
  abStats.diffRatio = diffPixels / (VIEW_W * VIEW_H);
  abStats.maxBlock = blocks.max;
  abStats.blocksOver100 = blocks.over100;
  abStats.note =
    blocks.over100 === 0
      ? "没有大块差异 —— 差异都是采样噪声"
      : `有 ${blocks.over100} 块 >100 像素的差异，需要查`;

  renderStats();
}

main().catch((error) => {
  abStats.error = String((error as Error)?.stack ?? error);
  renderStats();
  console.error("[ab-diff] 崩了：", error);
});
