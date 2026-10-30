/**
 * Phaser 测试替身 —— 让**改造前的 Phaser 代码**能在单测里跑起来。
 *
 * ## 为什么需要它
 *
 * 阶段 8.1 的验收标准是「builder 产出的坐标与老 WorldScene **逐点相等**」。
 * 基准必须是**改造前的字面实现**（从 git 历史提取）。
 *
 * 老代码依赖 Phaser（`WorldScene extends Phaser.Scene`、
 * `CharacterSprite extends Phaser.GameObjects.Container`）。
 * 真 Phaser 在 node 里跑不起来（要 canvas、要 DOM），所以这里给一个
 * **只记录不渲染**的替身。
 *
 * ## 替身只换「画到哪儿」，不换「算成什么」
 *
 * 替身里所有图形对象都把调用**记下来**（`ops` / `x` / `y` / `width`…）。
 * 改造前代码里的**算术一个字都没改** —— 它算出来什么位置，
 * 替身就记下什么位置。
 *
 * 换句话说：**被 A/B 检验的那段逻辑是逐字的老代码**，
 * 替身只是把「画到 GPU」换成「记到数组」。
 *
 * ## 尺寸公式照抄 Phaser
 *
 * 文字这块最容易走偏 —— Phaser 的 `Text.width` **不是**文字本身的宽度：
 *
 * ```
 * Text.width  = 文字盒宽 + padding.left + padding.right
 * Text.height = 文字盒高 + padding.top  + padding.bottom
 * ```
 *
 * 替身照抄这个公式（`StubText`），
 * 所以 A/B 里两边量出来的数字可以直接比。
 *
 * ## 相机
 *
 * 替身的相机模型跟 Phaser 一致：
 *
 * - `scrollX` / `scrollY` —— 相机滚动（**屏幕像素**，不是世界坐标）
 * - `worldView` —— 视口左上角对应的**世界坐标**（含取整）
 * - `zoom`
 *
 * 屏幕坐标公式（Phaser 的实际渲染公式）：
 *
 * ```
 * screenX = (worldX - worldView.x) * zoom + camera.x
 * ```
 *
 * ## 为什么相机的 `worldView` 里有取整，而契约里没有
 *
 * Phaser 的 `worldView.x = floor((midPoint - displayWidth/2) + 0.5)`，
 * `displayWidth = floor(width/zoom + 0.5)` —— **混了取整**。
 *
 * 取整在 GPU 渲染里无所谓（反正会取整），
 * 但 DOM 覆盖层是**另一个层**，取整误差会让名牌跟角色差半个像素。
 *
 * 契约（`render-model.ts`）用 `scrollX`（视口左上角的世界坐标，**不带取整**）
 * —— 「谁来取整」变成渲染实现的事。
 *
 * 这个替身**两个都给**：`worldView`（老的，带取整）和
 * `worldOrigin`（视口左上角的世界坐标，不带取整）。
 * A/B 对比时两边喂同一个值，才能保证比的是「被搬的逻辑」，
 * 不是「相机的取整」。
 */

/* ── 记录下来的绘制调用 ────────────────────────────────────────── */

/** 一次绘制调用。 */
export interface RecordedOp {
  /** 画在什么对象上。 */
  on: string;
  /** 调用名。 */
  op: string;
  /** 参数。 */
  args: unknown[];
  /**
   * 调用时的填充样式。
   *
   * Phaser 的 `Graphics` 是**有状态的**：`fillStyle()` 之后的
   * `fillRect()` 用的是那个样式。不把样式一起记下来，
   * 记下来的矩形就不知道是什么颜色。
   */
  fill?: { color: number; alpha: number };
  /** 调用时的描边样式。 */
  line?: { color: number; alpha: number; width: number };
}

/* ── 文字测量 ──────────────────────────────────────────────────── */

/**
 * 文字测量函数 —— 由测试注入。
 *
 * ## 返回值的语义
 *
 * 返回的是**文字盒子的大小，不含 padding**：
 *
 * - `width` —— 文字本身的宽度
 * - `height` —— 文字本身的高度
 *
 * Phaser 的 `Text.width` 则是「文字盒 + padding」——
 * 替身照抄那个公式（见 `StubText`），
 * 所以两边量出来的数字可以直接比。
 */
export type StubTextMeasurer = (
  text: string,
  font?: string,
) => { width: number; height: number };

/**
 * 全局槽 —— 测量函数存在**这里**，不放在模块变量里。
 *
 * ## 为什么不用模块级变量
 *
 * 替身文件会被复制到临时目录再由 `tsx` 加载，而 `tsx` 解析
 * `./phaser-stub.js` 和 `./phaser-stub.ts` 可能给出**两个不同的模块实例**
 * —— 那样 `setStubTextMeasurer` 设进 A，测量却从 B 读，
 * **静默失效**（尺寸恒定差一截，看不出是桩件问题）。
 *
 * 挂到 `globalThis` 上，**几个实例都指向同一个槽**。
 */
const MEASURER_SLOT = "__ownWorldStubTextMeasurer";

let textMeasurer: StubTextMeasurer = (text: string) => ({
  width: text.length * 8,
  height: 16,
});

/**
 * 设置替身的文字测量方式。
 *
 * 测试里把它指向 builder 用的同一个测量函数 ——
 * 两边测出来一样宽，尺寸才可比。
 */
export function setStubTextMeasurer(measurer: StubTextMeasurer): void {
  (globalThis as Record<string, unknown>)[MEASURER_SLOT] = measurer;
}

/** 读当前生效的测量函数（从全局槽读，跨模块实例一致）。 */
export function getStubTextMeasurer(): StubTextMeasurer {
  const slot = (globalThis as Record<string, unknown>)[MEASURER_SLOT];
  return (slot as StubTextMeasurer | undefined) ?? textMeasurer;
}

/* ── 图形对象 ──────────────────────────────────────────────────── */

/** 记录所有绘制调用的对象。 */
export class StubGraphics {
  ops: RecordedOp[] = [];
  depth = 0;
  visible = true;
  x = 0;
  y = 0;

  /** 当前填充样式（Phaser 的 `Graphics` 是有状态的）。 */
  private currentFill?: { color: number; alpha: number };
  /** 当前描边样式。 */
  private currentLine?: { color: number; alpha: number; width: number };

  private record(op: string, ...args: unknown[]) {
    this.ops.push({
      on: "graphics",
      op,
      args,
      fill: this.currentFill,
      line: this.currentLine,
    });
    return this;
  }

  fillStyle(color: number, alpha = 1) {
    this.currentFill = { color, alpha };
    this.ops.push({ on: "graphics", op: "fillStyle", args: [color, alpha] });
    return this;
  }
  lineStyle(width: number, color: number, alpha = 1) {
    this.currentLine = { color, alpha, width };
    this.ops.push({ on: "graphics", op: "lineStyle", args: [width, color, alpha] });
    return this;
  }
  fillRect(x: number, y: number, w: number, h: number) { return this.record("fillRect", x, y, w, h); }
  strokeRect(x: number, y: number, w: number, h: number) { return this.record("strokeRect", x, y, w, h); }
  fillRoundedRect(x: number, y: number, w: number, h: number, r?: number) { return this.record("fillRoundedRect", x, y, w, h, r); }
  strokeRoundedRect(x: number, y: number, w: number, h: number, r?: number) { return this.record("strokeRoundedRect", x, y, w, h, r); }
  fillCircle(x: number, y: number, r: number) { return this.record("fillCircle", x, y, r); }
  strokeCircle(x: number, y: number, r: number) { return this.record("strokeCircle", x, y, r); }
  fillEllipse(x: number, y: number, w: number, h: number) { return this.record("fillEllipse", x, y, w, h); }
  fillTriangle(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) { return this.record("fillTriangle", x1, y1, x2, y2, x3, y3); }
  fillPoints() { return this.record("fillPoints"); }
  clear() { this.ops.length = 0; return this; }
  setDepth(depth: number) { this.depth = depth; return this; }
  setVisible(visible: boolean) { this.visible = visible; return this; }
  setPosition(x: number, y: number) { this.x = x; this.y = y; return this; }
  destroy() {}
}

/** 记录文字的对象。 */
export class StubText {
  content = "";
  x = 0;
  y = 0;
  depth = 0;
  visible = true;
  originX = 0;
  originY = 0;
  style: Record<string, unknown> = {};

  constructor(
    x: number,
    y: number,
    content: string,
    style: Record<string, unknown> = {},
  ) {
    this.x = x;
    this.y = y;
    this.content = content;
    this.style = style;
  }

  /**
   * 拼出来的 CSS `font` 简写 —— 跟 Phaser 的 `TextStyle._font` 一个算法。
   *
   * `[fontStyle, fontSize, fontFamily].join(" ").trim()`
   *
   * 之所以要拼：builder 传给测量函数的 `font` 字符串
   * 就是这么拼出来的 —— 两边字符串一样，测出来的宽度才一样。
   */
  get font(): string {
    const style = this.style as {
      fontStyle?: string;
      fontSize?: string | number;
      fontFamily?: string;
    };
    return [style.fontStyle ?? "", style.fontSize ?? "16px", style.fontFamily ?? ""]
      .join(" ")
      .trim();
  }

  /** padding —— Phaser 的 `Text.padding` 默认全是 0。 */
  private get padding(): { left: number; right: number; top: number; bottom: number } {
    const raw = (this.style as { padding?: Record<string, number> }).padding;
    return {
      left: raw?.left ?? 0,
      right: raw?.right ?? 0,
      top: raw?.top ?? 0,
      bottom: raw?.bottom ?? 0,
    };
  }

  /** 描边粗细 —— Phaser 的 `TextStyle.strokeThickness` 默认 0。 */
  private get strokeThickness(): number {
    return (this.style as { strokeThickness?: number }).strokeThickness ?? 0;
  }

  /**
   * 文字盒（**不含** padding，**含**描边）—— 照抄 Phaser 的 `GetTextSize`。
   *
   * ```
   * 宽 = ceil(文字宽 + 描边粗细)
   * 高 = 文字行高 + 描边粗细
   * ```
   *
   * 描边是**往外**画的，所以它让文本框变大。
   */
  private get textBox(): { width: number; height: number } {
    const raw = getStubTextMeasurer()(this.content, this.font);
    const stroke = this.strokeThickness;
    return {
      width: Math.ceil(raw.width + stroke),
      height: raw.height + stroke,
    };
  }

  /** 照抄 Phaser：`文字盒 + 左右 padding`。 */
  get width(): number {
    const box = this.textBox;
    const pad = this.padding;
    return box.width + pad.left + pad.right;
  }

  /** 照抄 Phaser：`文字盒 + 上下 padding`。 */
  get height(): number {
    const box = this.textBox;
    const pad = this.padding;
    return box.height + pad.top + pad.bottom;
  }

  setText(content: string) { this.content = content; return this; }
  updateText() { return this; }
  setStyle(style: Record<string, unknown>) { this.style = { ...this.style, ...style }; return this; }
  setPosition(x: number, y: number) { this.x = x; this.y = y; return this; }
  setX(x: number) { this.x = x; return this; }
  setY(y: number) { this.y = y; return this; }
  setOrigin(ox: number, oy: number) { this.originX = ox; this.originY = oy; return this; }
  setDepth(depth: number) { this.depth = depth; return this; }
  setVisible(visible: boolean) { this.visible = visible; return this; }
  destroy() {}
}

/** 椭圆 / 圆 / 弧。 */
export class StubEllipse {
  x = 0;
  y = 0;
  width = 0;
  height = 0;
  radius = 0;
  fillColor = 0;
  fillAlpha = 1;
  strokeColor = 0;
  strokeAlpha = 1;
  strokeWidth = 0;
  isFilled = false;
  isStroked = false;
  visible = true;
  depth = 0;
  originX = 0.5;
  originY = 0.5;

  constructor(x: number, y: number, width: number, height: number, fillColor?: number, fillAlpha?: number) {
    this.x = x; this.y = y; this.width = width; this.height = height;
    if (fillColor !== undefined) { this.fillColor = fillColor; this.fillAlpha = fillAlpha ?? 1; this.isFilled = true; }
    this.radius = Math.max(width, height) / 2;
  }

  setFillStyle(color: number, alpha = 1) { this.fillColor = color; this.fillAlpha = alpha; this.isFilled = true; return this; }
  setStrokeStyle(width: number, color: number, alpha = 1) {
    this.strokeWidth = width; this.strokeColor = color; this.strokeAlpha = alpha; this.isStroked = true;
    return this;
  }
  setPosition(x: number, y: number) { this.x = x; this.y = y; return this; }
  setOrigin(ox: number, oy: number) { this.originX = ox; this.originY = oy; return this; }
  setVisible(visible: boolean) { this.visible = visible; return this; }
  setDepth(depth: number) { this.depth = depth; return this; }
  destroy() {}
}

/** 弧（Phaser 的 `add.arc`）。 */
export class StubArc extends StubEllipse {
  startAngle = 0;
  endAngle = 360;
  anticlockwise = false;

  constructor(
    x: number, y: number, radius: number,
    startAngle: number, endAngle: number,
    anticlockwise: boolean,
    fillColor?: number, fillAlpha?: number,
  ) {
    super(x, y, radius * 2, radius * 2, fillColor, fillAlpha);
    this.radius = radius;
    this.startAngle = startAngle;
    this.endAngle = endAngle;
    this.anticlockwise = anticlockwise;
  }
}

/** 精灵。 */
export class StubSprite {
  x = 0;
  y = 0;
  textureKey = "";
  frame = 0;
  displayWidth = 0;
  displayHeight = 0;
  originX = 0.5;
  originY = 0.5;
  flipX = false;
  visible = true;
  depth = 0;
  tint = 0;

  constructor(x: number, y: number, textureKey: string, frame?: number) {
    this.x = x; this.y = y; this.textureKey = textureKey;
    if (frame !== undefined) this.frame = frame;
  }

  setDisplaySize(w: number, h: number) { this.displayWidth = w; this.displayHeight = h; return this; }
  setOrigin(ox: number, oy: number) { this.originX = ox; this.originY = oy; return this; }
  setFrame(frame: number) { this.frame = frame; return this; }
  setFlipX(flip: boolean) { this.flipX = flip; return this; }
  setTint(tint: number) { this.tint = tint; return this; }
  clearTint() { this.tint = 0; return this; }
  setPosition(x: number, y: number) { this.x = x; this.y = y; return this; }
  setVisible(visible: boolean) { this.visible = visible; return this; }
  setDepth(depth: number) { this.depth = depth; return this; }
  stop() { return this; }
  play(_key: string, _ignoreIfPlaying?: boolean) { return this; }
  destroy() {}
}

/** 交互区域（`add.zone`）—— 记录事件回调，测试可以手动触发。 */
export class StubZone {
  x = 0;
  y = 0;
  width = 0;
  height = 0;
  handlers: Record<string, Array<(...args: unknown[]) => void>> = {};

  constructor(x: number, y: number, width: number, height: number) {
    this.x = x; this.y = y; this.width = width; this.height = height;
  }

  setOrigin(_ox: number, _oy: number) { return this; }
  setInteractive() { return this; }
  on(event: string, handler: (...args: unknown[]) => void) {
    (this.handlers[event] ??= []).push(handler);
    return this;
  }
  /** 测试用：触发某个事件。 */
  emit(event: string, ...args: unknown[]) {
    for (const handler of this.handlers[event] ?? []) handler(...args);
    return this;
  }
  destroy() {}
}

/** 容器。 */
export class StubContainer {
  x = 0;
  y = 0;
  scaleX = 1;
  scaleY = 1;
  visible = true;
  /** Phaser 的 `GameObject.active` —— 旧代码用它判断「要不要画名牌」。 */
  active = true;
  depth = 0;
  /**
   * 子对象列表 —— **Phaser 的 `Container` 用的就是这个名字**（`list`）。
   *
   * 旧代码有 `entityLayer.list.sort(...)` 这种写法，
   * 所以替身必须提供**同名**的属性，否则老代码直接崩。
   */
  list: unknown[] = [];
  /**
   * 所属场景。
   *
   * 旧代码里 `CharacterSprite` 是 `Container` 的子类，
   * 它在 `createVisuals()` 里用 `this.scene.add.ellipse(...)` 建图形 ——
   * 也就是说**容器必须能找回自己的场景**。
   */
  scene: StubScene | undefined;

  constructor(scene?: unknown, x = 0, y = 0) {
    this.scene = scene as StubScene | undefined;
    this.x = x;
    this.y = y;
  }
  /** Phaser 的 `Container.add` 接受数组 —— 这里摊平。 */
  add(child: unknown) {
    if (Array.isArray(child)) this.list.push(...child);
    else this.list.push(child);
    return this;
  }
  /** 旧代码（和测试）用的另一个名字 —— 指向同一个数组。 */
  get children(): unknown[] {
    return this.list;
  }
  setPosition(x: number, y: number) { this.x = x; this.y = y; return this; }
  setX(x: number) { this.x = x; return this; }
  setY(y: number) { this.y = y; return this; }
  setScale(scaleX: number, scaleY = scaleX) {
    this.scaleX = scaleX;
    this.scaleY = scaleY;
    return this;
  }
  setVisible(visible: boolean) { this.visible = visible; return this; }
  setDepth(depth: number) { this.depth = depth; return this; }
  setActive(active: boolean) { this.active = active; return this; }
  setInteractive(_config?: unknown) { return this; }
  destroy(_fromScene?: boolean) {}
}

/* ── 相机 ──────────────────────────────────────────────────────── */

/**
 * 相机 —— 跟 Phaser 的 `Camera` 一个模型。
 *
 * `worldView` 复刻 Phaser 的取整公式：
 *
 * ```
 * displayWidth = floor(width / zoom + 0.5)
 * midPoint     = scrollX + width / 2
 * worldView.x  = floor(midPoint - displayWidth / 2 + 0.5)
 * ```
 */
export class StubCamera {
  x = 0;
  y = 0;
  width = 800;
  height = 600;
  zoom = 1;
  scrollX = 0;
  scrollY = 0;
  worldView = { x: 0, y: 0, width: 800, height: 600 };

  setSize(width: number, height: number) {
    this.width = width; this.height = height;
    return this;
  }

  setZoom(zoom: number) {
    this.zoom = zoom;
    return this;
  }

  /** 按 Phaser 的公式重算 `worldView`。 */
  preRender(): void {
    const halfWidth = this.width * 0.5;
    const halfHeight = this.height * 0.5;
    const midX = this.scrollX + halfWidth;
    const midY = this.scrollY + halfHeight;
    const displayWidth = Math.floor(this.width / this.zoom + 0.5);
    const displayHeight = Math.floor(this.height / this.zoom + 0.5);
    this.worldView = {
      x: Math.floor(midX - displayWidth / 2 + 0.5),
      y: Math.floor(midY - displayHeight / 2 + 0.5),
      width: displayWidth,
      height: displayHeight,
    };
  }

  /**
   * 视口左上角对应的**世界坐标**（不带取整）。
   *
   * 这是契约里 `CameraState.scrollX` 的语义 ——
   * 跟 `worldView.x` 是同一个东西，区别只在取整。
   */
  get worldOriginX(): number {
    return this.scrollX + this.width / 2 - this.width / (2 * this.zoom);
  }

  get worldOriginY(): number {
    return this.scrollY + this.height / 2 - this.height / (2 * this.zoom);
  }
}

/* ── 场景 ──────────────────────────────────────────────────────── */

/** 事件发射器（Phaser 的 `EventEmitter`）。 */
export class StubEventEmitter {
  private handlers: Record<string, Array<(...args: unknown[]) => void>> = {};

  on(event: string, handler: (...args: unknown[]) => void) {
    (this.handlers[event] ??= []).push(handler);
    return this;
  }
  once(event: string, handler: (...args: unknown[]) => void) {
    return this.on(event, handler);
  }
  off(event: string, handler?: (...args: unknown[]) => void) {
    if (!handler) { delete this.handlers[event]; return this; }
    this.handlers[event] = (this.handlers[event] ?? []).filter((h) => h !== handler);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    for (const handler of [...(this.handlers[event] ?? [])]) handler(...args);
    return this;
  }
  removeAllListeners() { this.handlers = {}; return this; }
}

/** 计时器。 */
export class StubTimerEvent {
  remove(_dispose?: boolean) {}
  get elapsed() { return 0; }
}

/** 补间。 */
export class StubTween {
  stop() {}
  pause() {}
  resume() {}
}

/**
 * 场景 —— `WorldScene` 的基类替身。
 *
 * 只需要 `this.add`（画东西）和 `this.cameras`（相机）。
 */
export class StubScene {
  add: {
    graphics: () => StubGraphics;
    text: (x: number, y: number, content: string, style?: Record<string, unknown>) => StubText;
    container: (x?: number, y?: number, children?: unknown[]) => StubContainer;
    ellipse: (x: number, y: number, w: number, h: number, color?: number, alpha?: number) => StubEllipse;
    circle: (x: number, y: number, r: number, color?: number, alpha?: number) => StubEllipse;
    arc: (x: number, y: number, r: number, start: number, end: number, cw: boolean, color?: number, alpha?: number) => StubArc;
    sprite: (x: number, y: number, key: string, frame?: number) => StubSprite;
    zone: (x: number, y: number, w: number, h: number) => StubZone;
    rectangle: (x: number, y: number, w: number, h: number, color?: number, alpha?: number) => StubEllipse;
    image: (x: number, y: number, key: string) => StubSprite;
    existing: (child: unknown) => unknown;
  };

  cameras = { main: new StubCamera() };
  /**
   * 纹理是否存在 —— **可配置**。
   *
   * 旧代码用 `scene.textures.exists(characterId)` 判断角色有没有贴图
   * （有贴图画精灵，没贴图画圆）。A/B 要覆盖两条路，所以这里能配置。
   */
  textures = {
    exists: (key: string) => this.existingTextures.has(key),
  };
  /** 存在的纹理 key 集合。 */
  existingTextures = new Set<string>();
  anims = {
    exists: (_key: string) => true,
    create: (_config: unknown) => {},
    generateFrameNumbers: (_key: string, _config: unknown) => [] as number[],
  };
  time = {
    delayedCall: (_delay: number, _callback: () => void) => new StubTimerEvent(),
  };
  tweens = { add: (_config: unknown) => new StubTween() };
  events = new StubEventEmitter();
  /** 建出来的交互区域 —— 测试要靠它触发 `pointerover`。 */
  zones: StubZone[] = [];
  /** 建出来的图形对象 —— 测试要靠它读绘制记录。 */
  graphics: StubGraphics[] = [];
  /** 建出来的文字对象。 */
  texts: StubText[] = [];

  constructor(_config?: unknown) {
    this.add = {
      graphics: () => {
        const g = new StubGraphics();
        this.graphics.push(g);
        return g;
      },
      text: (x, y, content, style) => {
        const t = new StubText(x, y, content, style);
        this.texts.push(t);
        return t;
      },
      container: (x = 0, y = 0, children = []) => {
        const container = new StubContainer(this, x, y);
        container.list.push(...children);
        return container;
      },
      ellipse: (x, y, w, h, color, alpha) => new StubEllipse(x, y, w, h, color, alpha),
      circle: (x, y, r, color, alpha) => new StubEllipse(x, y, r * 2, r * 2, color, alpha),
      arc: (x, y, r, start, end, cw, color, alpha) => new StubArc(x, y, r, start, end, cw, color, alpha),
      sprite: (x, y, key, frame) => new StubSprite(x, y, key, frame),
      zone: (x, y, w, h) => {
        const zone = new StubZone(x, y, w, h);
        this.zones.push(zone);
        return zone;
      },
      rectangle: (x, y, w, h, color, alpha) => new StubEllipse(x, y, w, h, color, alpha),
      image: (x, y, key) => new StubSprite(x, y, key),
      existing: (child) => child,
    };
  }
}

/* ── 最小 DOM ──────────────────────────────────────────────────── */

/**
 * 最小 DOM —— 只够 `CharacterSprite.createDomLabel()` 跑起来。
 *
 * 旧实现的名牌是 `HTMLDivElement` + CSS：它自己建元素、
 * 自己写 `style.left` / `style.top`。
 *
 * A/B 要比的就是那两个坐标，所以这里给一个**能记下 style 的假元素**，
 * 而不是真 DOM —— node 里没有 DOM，而且真 DOM 还要测「写进去没有」。
 */
export class FakeElement {
  style: Record<string, string> = {};
  className = "";
  textContent = "";
  children: FakeElement[] = [];

  appendChild(child: FakeElement) { this.children.push(child); return child; }
  append(...children: FakeElement[]) { this.children.push(...children); }
  remove() {}
  setAttribute(_name: string, _value: string) {}
}

/**
 * 装一个最小 `document` 全局。
 *
 * 返回一个「元素仓库」，测试可以按 id 找到某个元素。
 *
 * ## 为什么不用 jsdom
 *
 * jsdom 能用，但这里只需要「能建元素、能写 style」——
 * 为此拉一整套 DOM 太重，而且引入了「真 DOM 行为」这种
 * 跟被测逻辑无关的变量。
 */
export function installFakeDom(
  ids: string[] = ["label-root", "ui-root"],
): { elements: Map<string, FakeElement>; restore: () => void } {
  const elements = new Map<string, FakeElement>();
  for (const id of ids) elements.set(id, new FakeElement());

  const previous = (globalThis as Record<string, unknown>).document;
  (globalThis as Record<string, unknown>).document = {
    getElementById: (id: string) => elements.get(id) ?? null,
    createElement: () => new FakeElement(),
    body: new FakeElement(),
  };

  return {
    elements,
    restore: () => {
      if (previous === undefined) delete (globalThis as Record<string, unknown>).document;
      else (globalThis as Record<string, unknown>).document = previous;
    },
  };
}

/* ── 数学 ──────────────────────────────────────────────────────── */

/** `Phaser.Math.Clamp`。 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** `Phaser.Math.Distance.Between`。 */
export const distanceBetween = (
  x1: number, y1: number, x2: number, y2: number,
): number => Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);

/** `Phaser.Geom.Rectangle` —— 只需要 `Contains`。 */
export class Rectangle {
  constructor(
    public x = 0,
    public y = 0,
    public width = 0,
    public height = 0,
  ) {}
  static Contains(rect: Rectangle, x: number, y: number): boolean {
    return (
      x >= rect.x &&
      x <= rect.x + rect.width &&
      y >= rect.y &&
      y <= rect.y + rect.height
    );
  }
}

/* ── 默认导出（Phaser 的命名空间形状）────────────────────────────── */

/**
 * Phaser 的命名空间形状。
 *
 * 改造前的代码是 `import Phaser from "phaser"`，然后用
 * `Phaser.GameObjects.Container`、`Phaser.Math.Clamp` 这样访问 ——
 * 这个对象按同样的形状提供。
 */
const Phaser = {
  Scene: StubScene,
  Events: { EventEmitter: StubEventEmitter },
  Time: { TimerEvent: StubTimerEvent },
  Tweens: { Tween: StubTween },
  GameObjects: {
    Container: StubContainer,
    Graphics: StubGraphics,
    Text: StubText,
    Ellipse: StubEllipse,
    Arc: StubArc,
    Sprite: StubSprite,
    Zone: StubZone,
  },
  Geom: { Rectangle },
  Math: {
    Clamp: clamp,
    Distance: { Between: distanceBetween },
  },
  Scenes: { Events: { SHUTDOWN: "shutdown" } },
  Types: {
    GameObjects: { Text: { TextStyle: {} } },
    Input: { Keyboard: { CursorKeys: {}, Key: {} } },
  },
  Input: { Keyboard: { Key: {} } },
  Cameras: { Scene2D: { Camera: StubCamera } },
};

export default Phaser;
