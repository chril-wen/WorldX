/**
 * 渲染模型 —— 「要画什么」的纯数据契约。
 *
 * ## 这里为什么是纯数据
 *
 * 阶段 8 要换掉 Phaser 渲染层。**换栈的前提是接口先定死** ——
 * 否则每个人按自己的理解画，最后推倒重来。
 *
 * 所以这一层只描述「这个场景里有这些东西，画在哪」：
 * **不碰 canvas、不碰 Phaser、不碰 DOM、不碰 React。**
 * 渲染实现（Canvas 2D / Pixi / SVG / WebGL）各自实现 `SceneRenderer`，
 * 只依赖这里的类型。
 *
 * ## 三层结构
 *
 * ```
 * ┌────────────────────────────────────────────┐
 * │  面板层（React，8378 行）—— 不用重写        │
 * │  依赖：render-model + server API            │
 * ├────────────────────────────────────────────┤
 * │  渲染模型层（本文件）—— 纯数据              │
 * │  packages/client-core/src/render/           │
 * ├────────────────────────────────────────────┤
 * │  渲染实现层（可换、可并行）                 │
 * │  Canvas2D / Pixi / SVG / WebGL …            │
 * └────────────────────────────────────────────┘
 * ```
 *
 * ## 坐标系：**世界坐标**，不是屏幕坐标
 *
 * 所有 `DrawItem` 的 x/y 都是**世界像素**。相机负责把世界坐标映射到屏幕。
 *
 * 这样做的理由：`MapManager.getMainAreaPlacement()` 这类位置计算
 * 产出的是世界坐标，**位置逻辑只写一遍**（在 client-core 里），
 * 渲染实现只负责乘一次变换矩阵。
 *
 * 变换约定见 `CameraState`：
 * `screenX = (worldX - camera.scrollX) * camera.zoom + camera.viewportX`
 *
 * ## 为什么图元种类这么少
 *
 * 这不是「通用矢量图形格式」。集合是**按现有 Phaser 画法倒推出来的** ——
 * 现有代码只用了矩形、圆、椭圆、三角形、文本、图片、精灵这几样。
 * 加一种图元 = 渲染实现要多实现一种 = 并行开发时多一处能走偏的地方。
 *
 * 现有画法与图元的对应关系：
 *
 * | Phaser | 图元 |
 * |---|---|
 * | `add.rectangle` / `graphics.fillRect` | `rect` |
 * | `graphics.fillRoundedRect` | `rect`（`radius` 字段） |
 * | `add.circle` / `graphics.fillCircle` | `ellipse`（`radiusX === radiusY`） |
 * | `add.ellipse` / `graphics.fillEllipse` | `ellipse` |
 * | `graphics.fillTriangle` | `polygon` |
 * | `add.arc` | `ellipse`（部分弧，见 `arcStart`/`arcEnd`） |
 * | `add.text` | `text` |
 * | `add.image` | `image` |
 * | `add.sprite` | `sprite` |
 * | `add.zone` | **无对应** —— 它是命中区域，不是图元 |
 *
 * ## 颜色一律用 CSS 字符串
 *
 * 不用 `0xffd166` 这种数字。理由：Phaser 的数字颜色（`0xRRGGBB`）和
 * CSS 颜色字符串是两种写法，每种渲染实现都得做一次转换 ——
 * 转成数字的（Canvas 2D）要 `rgb(r,g,b)`，转成字符串的（SVG）不用。
 *
 * 统一用 CSS 字符串，实现方直接用，少一处能走偏的地方。
 * 需要透明度就用 `alpha` 字段，**不要**塞 `rgba()` 进去 ——
 * 塞进去的话，命中测试和边框算色就不好做了。
 */

/**
 * 一个可绘制图元 —— 渲染实现只需要知道「画这个」。
 *
 * 联合类型，字段用 `kind` 区分。
 */
export type DrawItem =
  | DrawImage
  | DrawRect
  | DrawEllipse
  | DrawPolygon
  | DrawText
  | DrawSprite
  | DrawPolyline;

/** 图片 —— 地图底图、静态插图。 */
export interface DrawImage {
  kind: "image";
  /** 渲染实现内部用来做拾取的标识（不保证唯一到每个渲染实现）。 */
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * 图片来源 —— **由渲染实现决定怎么解释**。
   *
   * Canvas 2D 会当成 URL；Pixi 会当成纹理 key。
   * 契约层不规定它是什么 —— 只保证它是一个**稳定的字符串**。
   */
  source: string;
  alpha?: number;
}

/** 矩形 —— 区域框、覆盖层格子、气泡背景。 */
export interface DrawRect {
  kind: "rect";
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fill?: string;
  stroke?: string;
  lineWidth?: number;
  /**
   * 圆角半径（像素）。
   *
   * 现有画法里 `fillRoundedRect` 用得很勤（气泡、悬停高亮），
   * 圆角是**观感的一部分**，不是装饰 —— 抹掉就等于改了产品。
   */
  radius?: number;
  alpha?: number;
}

/** 椭圆 / 圆 —— 角色本体（无贴图时的兜底圆）、阴影、点位标记。 */
export interface DrawEllipse {
  kind: "ellipse";
  id: string;
  x: number;
  y: number;
  radiusX: number;
  radiusY: number;
  fill?: string;
  stroke?: string;
  lineWidth?: number;
  /**
   * 弧的起止角度（度）。
   *
   * 现有画法里 `add.arc` 画的是「高光弧」——一个 0~360 的完整圆弧，
   * 靠 `strokeStyle` 描边而不是填充。
   *
   * 给了起止角就是弧，不给就是整圆。
   */
  arcStart?: number;
  arcEnd?: number;
  alpha?: number;
}

/** 多边形 —— 现有画法里只有气泡的尾巴（三角形）。 */
export interface DrawPolygon {
  kind: "polygon";
  id: string;
  /** 顶点 —— 相对 `x`/`y` 的偏移。 */
  points: Array<{ x: number; y: number }>;
  x: number;
  y: number;
  fill?: string;
  stroke?: string;
  lineWidth?: number;
  alpha?: number;
}

/** 文本 —— 区域名、物件名、悬停标签。 */
export interface DrawText {
  kind: "text";
  id: string;
  /**
   * 文本框的**左上角**（世界坐标）。
   *
   * ## 为什么是左上角而不是基线
   *
   * 现有画法里这些文字是 Phaser 的 `Text`（默认 `origin(0, 0)`）——
   * 也就是「左上角对齐」。契约用同一个约定，
   * 渲染实现就不用猜「y 是基线还是顶边」了
   * （猜错的话，整排标签会高低错落一个字）。
   *
   * ## 框指的是**含背景的整个盒子**
   *
   * 给了 `background` / `padding` 时，框 = 文字盒 + 内边距；
   * 文字本身画在 `(x + padding.left, y + padding.top)`。
   *
   * 这跟 Phaser 的 `Text` 一个语义（它的 `width` 就是
   * `文字盒 + 左右内边距`）。
   */
  x: number;
  y: number;
  content: string;
  /**
   * CSS `font` 简写（如 `"bold 14px 'PingFang SC', sans-serif"`）。
   *
   * 用简写而不是拆成 size/family/weight 三个字段：
   * 三个字段的组合有无穷多种，渲染实现要自己拼 —— 拼法会不一致。
   * 一整串交给实现，实现直接用。
   */
  font: string;
  color: string;
  align?: "left" | "center" | "right";
  /**
   * 描边颜色。
   *
   * 现有画法里区域名 / 物件名 / 悬停标签都用黑色描边（`#000000`，粗细 2）——
   * 描边是**可读性的一部分**（浅色背景上也要看得清），
   * 少了它标签就跟背景糊在一起。
   */
  stroke?: string;
  /**
   * 描边粗细（像素）。
   *
   * 给 `stroke` 时才有意义。
   *
   * ## 注意：描边**占尺寸**
   *
   * 描边是往外画的，所以它让文本框**变大**：
   *
   * ```
   * 宽 = ceil(文字宽 + 描边粗细) + 左右内边距
   * 高 = 文字行高 + 描边粗细 + 上下内边距
   * ```
   *
   * （公式照抄 Phaser 的 `GetTextSize`。）
   */
  strokeThickness?: number;
  /**
   * 背景色（CSS 字符串）。
   *
   * 现有画法里区域名 / 物件名是**带深色底的 chip**：
   * `backgroundColor: "rgba(0, 0, 0, 0.65)"`。
   *
   * **为什么放在文字上而不是拆成两个图元** ——
   * 因为老实现里它就是**一个** Phaser `Text`
   * （背景和字在同一个 canvas 上）。
   * 拆成两个图元，渲染实现就得自己判断「哪个矩形是这块字的底」——
   * 那是可以走偏的地方。
   */
  background?: string;
  /**
   * 背景不透明度（0~1）。
   *
   * 给 `background` 时才有意义。
   *
   * 契约的颜色**一律用 CSS 字符串**、透明度**一律用 `alpha` 字段** ——
   * 所以这里不塞 `rgba()`。
   */
  backgroundAlpha?: number;
  /**
   * 内边距（像素）。
   *
   * 现有画法里 chip 的内边距是 `{ left: 6, right: 6, top: 3, bottom: 3 }`。
   *
   * 不给就是 0（文字紧贴框）。
   */
  padding?: {
    left?: number;
    right?: number;
    top?: number;
    bottom?: number;
  };
  /**
   * 文本框的尺寸（像素）—— **含内边距，不含描边**。
   *
   * ## 什么时候需要给
   *
   * 给了 `background` 时**必须给** ——
   * 渲染实现要靠它画背景矩形，而它自己不一定有字体引擎
   * （或者量出来的宽度跟 builder 用的是不同的字体）。
   *
   * 不给背景时可以不填 —— 渲染实现自己量就行。
   */
  width?: number;
  height?: number;
  /**
   * 换行宽度上限（像素）。超过就折行。
   *
   * 现有画法里气泡文本用了 `wordWrap: { width, useAdvancedWrap: true }`。
   * 不给就**不折行** —— 契约层不做「不折行也不给上限」的假设。
   */
  maxWidth?: number;
  alpha?: number;
}

/** 精灵 —— 有贴图的角色。 */
export interface DrawSprite {
  kind: "sprite";
  id: string;
  /**
   * 锚点（世界坐标）—— **不是**图片的左上角。
   *
   * ## 为什么精灵要单独有 origin
   *
   * 现有画法里角色的贴图是 `setOrigin(0.5, 0.85)` ——
   * 锚点在**贴图宽度的中间、高度的 85% 处**。
   *
   * 这不是随手写的：`0.85` 决定了「角色脚底在哪」和「头顶在哪」。
   * 头顶位置又决定了名牌挂哪儿（见 `getHeadWorldOffset()`）。
   *
   * 契约里如果没有 origin，渲染实现会按「左上角对齐」或「居中」画 ——
   * 角色会浮起来或者陷进地里，名牌也跟着错位。
   *
   * 默认值跟 Phaser 一致：`0.5` / `0.5`。
   */
  x: number;
  y: number;
  /**
   * 水平锚点（0 = 左边缘，0.5 = 中心，1 = 右边缘）。
   *
   * 默认 0.5（Phaser 的默认值）。
   */
  originX?: number;
  /**
   * 垂直锚点（0 = 上边缘，0.5 = 中心，1 = 下边缘）。
   *
   * 默认 0.5（Phaser 的默认值）。角色的贴图用的是 **0.85**。
   */
  originY?: number;
  source: string;
  /** 帧号。贴图集（spritesheet）的帧索引。 */
  frame?: number;
  width: number;
  height: number;
  /**
   * 水平翻转。
   *
   * 角色朝向左右就是靠这个 —— 现有画法里 `setFlipX` 用在走动动画上。
   */
  flipX?: boolean;
  /**
   * 染色（十六进制色值，如 `"#ddddff"`）。
   *
   * 现有画法里悬停时 `setTint(0xddddff)` —— 悬停高亮就靠这个。
   */
  tint?: string;
  alpha?: number;
}

/** 折线 —— 寻路路径这类连线。 */
export interface DrawPolyline {
  kind: "polyline";
  id: string;
  points: Array<{ x: number; y: number }>;
  stroke: string;
  lineWidth: number;
  alpha?: number;
}

/** 一个图层 —— 图元按 depth 排序，后面的盖前面的。 */
export interface RenderLayer {
  id: string;
  /**
   * 层深 —— 越大越靠前。
   *
   * **跟现有 Phaser 的 depth 对齐**（见 `RenderScene.layers` 的说明），
   * 这样 8.1 搬迁时深度不用重算。
   */
  depth: number;
  items: DrawItem[];
}

/**
 * 相机状态 —— 世界坐标到屏幕坐标的变换。
 *
 * ## 变换公式
 *
 * ```
 * screenX = (worldX - scrollX) * zoom + viewportX
 * screenY = (worldY - scrollY) * zoom + viewportY
 * ```
 *
 * `viewportX`/`viewportY` 是相机视口在画布上的左上角。
 * 现在的 Phaser 相机 `x`/`y` 都是 0，所以这两个值是 0 ——
 * 但**契约里保留它**，因为换渲染栈时相机多半不再是「铺满画布」的。
 *
 * ## 为什么用 `scrollX` 而不是 `worldView.x`
 *
 * 现有 DOM 覆盖层（角色名牌、对话气泡）算屏幕位置用的是
 * `camera.worldView.x`，而它 = `floor(midPoint - displayWidth/2 + 0.5)`，
 * 里面**混了取整**。
 *
 * 取整在 Phaser 的渲染管线里无所谓（GPU 反正会取整），
 * 但 DOM 覆盖层是**另一个层**（`#label-root`，`z-index: 2`），
 * 取整误差会让名牌和角色**差半个像素到几个像素**。
 *
 * 契约里用 `scrollX`（不带取整）+ 显式的 `viewportX`，
 * 让「谁来取整」变成**渲染实现的事** —— 每个实现各自一致即可。
 */
export interface CameraState {
  /** 相机左上角对应的世界坐标。 */
  scrollX: number;
  scrollY: number;
  /** 缩放倍数。1 = 1:1。 */
  zoom: number;
  /** 视口在画布上的位置（像素）。 */
  viewportX: number;
  viewportY: number;
  /** 视口尺寸（像素）。 */
  viewportWidth: number;
  viewportHeight: number;
  /** 地图尺寸（像素）—— 缩放边界和「回到原位」要用。 */
  mapWidth: number;
  mapHeight: number;
}

/**
 * DOM 覆盖层 —— **不是 canvas 图元**。
 *
 * ## 为什么单独一段
 *
 * 现有 UI 里角色名牌和对话气泡**不是 Phaser 画的**，是
 * `HTMLDivElement` + CSS（`#label-root` 容器，`z-index: 2`，
 * 在 canvas 之上）。
 *
 * 现有代码里这段逻辑在 `CharacterSprite.updateDomLabelPosition()`：
 * 它自己算屏幕坐标、自己算字号（按缩放 clamp）、
 * 自己处理「超出视口就隐藏」。
 *
 * 如果契约不表达这一层，8.1 搬迁时这段逻辑就没有地方去 ——
 * 只能留在 client 里，或者重新设计一遍。
 *
 * ## 契约给什么、不给什么
 *
 * **给**：位置（屏幕坐标）、内容、可见性。
 * **不给**：具体样式。
 *
 * 样式（圆角、阴影、换行、渐变）是**渲染实现的事** ——
 * 现在是 CSS，换了栈可能还是 CSS，也可能不是。
 * 契约只保证「这里有一个名牌，上面写着这个名字，在屏幕的这个位置」。
 */
export interface OverlayItem {
  /** 覆盖层类型。渲染实现按类型决定画法。 */
  kind: "character-label" | "dialogue-bubble";
  /** 角色 id —— 同一个角色可能同时有名牌和气泡。 */
  characterId: string;
  /**
   * 屏幕坐标（**不是世界坐标**）—— 覆盖层已经算好屏幕位置了。
   *
   * 之所以给屏幕坐标而不是世界坐标：覆盖层是**独立的一层**，
   * 有自己的缩放行为（字号随缩放变，但位置由世界坐标决定）。
   * 让契约层同时承担「世界→屏幕」和「缩放后的样式」会搅在一起。
   */
  x: number;
  y: number;
  /** 主文本 —— 名牌上是角色名，气泡上是对话内容。 */
  content: string;
  /** 内心独白 —— 只在气泡上有。 */
  innerMonologue?: string;
  /** 动作标签 —— 名牌上的动作药丸。 */
  actionLabel?: string;
  /** 动作图标（emoji）—— 名牌上的小图标。 */
  actionIcon?: string;
  /** 缩放倍数 —— 渲染实现用它算字号（并按自己的规则 clamp）。 */
  zoom: number;
  /**
   * 是否在视口内。
   *
   * ## 为什么需要它
   *
   * 旧实现（`CharacterSprite.updateDomLabelPosition()`）会自己判断
   * 「屏幕坐标离视口超过 120px 就把名牌 `display:none`」。
   *
   * 那一段**没有搬进 scene-builder** —— 契约层本来就没有这个字段。
   * 结果是：视口外的角色仍然会产出名牌图元，
   * 渲染实现要么全画出来（视口外一堆名牌），
   * 要么自己重算一遍可见性（**位置逻辑就分散到两个地方了**）。
   *
   * 可见性判定属于**位置逻辑**，留在契约层。
   */
  visible: boolean;
}

/**
 * 一个命中区域 —— 「点这里算命中」，但**不画出来**。
 *
 * ## 为什么需要它
 *
 * 改造前的实现里，交互物件是**常驻**的 `add.zone`：
 * 悬停高亮、点击选中都靠它 —— **跟调试覆盖层开不开无关**。
 *
 * 但契约里「物件框」是**调试覆盖层**的一部分（`interactive-objects` 图层），
 * 覆盖层关掉时这一层就没有了。
 *
 * 如果命中测试只扫图层里的矩形，行为就跟改造前**不一样**了：
 * 覆盖层一关，物件就点不中了。
 *
 * 所以命中区域单独列出来 —— 它是**交互语义**，不是**画面**。
 *
 * ## 坐标
 *
 * 世界坐标（跟图元一样）。渲染实现负责换算成屏幕坐标。
 *
 * ## 顺序
 *
 * **从下往上**排 —— 后面的盖前面的，命中测试从末尾往前找，
 * 跟 Phaser 的输入列表一致（depth 大的先命中）。
 */
export interface HitArea {
  /** 命中后返回的 id。 */
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 渲染场景 —— 渲染实现拿到它，一次性画完。
 *
 * ## 为什么是一个「整场景」而不是「增量指令」
 *
 * 增量指令（moveSprite / setText）看着更省，但会让渲染实现
 * 各自维护一份「当前状态」，而**状态跟界面对不上**是这类架构最常见的 bug。
 *
 * 整场景是**纯函数式的**：给一份完整描述，渲染出画面。
 * 每帧重算一次场景就行 —— 自用规模下这点开销可以忽略
 * （`PROJECT.md` 明说「不追性能」）。
 */
export interface RenderScene {
  /** 地图底图 —— TMJ 渲染成的整幅图。 */
  background: {
    source: string;
    width: number;
    height: number;
  };
  /** 相机状态。 */
  camera: CameraState;
  /**
   * 图层，按 `depth` 升序绘制（后面的盖前面的）。
   *
   * **depth 的取值跟现有 Phaser 一致**，这样 8.1 搬迁时直接搬：
   *
   * | depth | 内容 |
   * |---|---|
   * | 4 | 可行走区域覆盖层（调试） |
   * | 10 | 角色层（按脚底 y 排序） |
   * | 15 | 悬停高亮 |
   * | 16 | 区域框 / 点位 / 悬停标签 |
   * | 17 | 区域名 / 物件名文字 |
   */
  layers: RenderLayer[];
  /**
   * DOM 覆盖层 —— 名牌和对话气泡。
   *
   * **不在 `layers` 里** —— 它们不是 canvas 图元，
   * 渲染实现可以选择用 DOM 画（跟现在一样）或用 canvas 画。
   */
  overlays: OverlayItem[];
}

/**
 * 渲染实现的接口 —— 每种技术栈实现一份。
 *
 * ## 生命周期
 *
 * ```
 * mount(container) → render(scene) × N → resize(w, h) → dispose()
 * ```
 *
 * `mount` 之后 `render` 可以被调用任意次；
 * `resize` 在视口变化时调用（之后应该再 `render` 一次）。
 */
export interface SceneRenderer {
  /** 挂载到容器。渲染实现自己管 canvas 的尺寸和 DPR。 */
  mount(container: HTMLElement): void;
  /** 卸载。 */
  unmount(): void;
  /** 渲染一个场景。 */
  render(scene: RenderScene): void;
  /** 视口尺寸变化。 */
  resize(width: number, height: number): void;
  /**
   * 命中测试 —— 屏幕坐标 → 画布上的对象 id。
   *
   * 没有命中就返回 `null`。
   *
   * **屏幕坐标，不是世界坐标** —— 调用方（点击处理）拿到的是
   * 鼠标在画布上的位置。
   */
  hitTest(screenX: number, screenY: number): string | null;
  /** 释放资源。 */
  dispose(): void;
}

/**
 * 世界坐标 → 屏幕坐标。
 *
 * **放在契约层，不放在渲染实现里** ——
 * 因为 DOM 覆盖层和 canvas 图元**必须用同一个变换**，
 * 否则名牌会跟角色错开。两处各算一遍 = 迟早算歪。
 *
 * 现有 DOM 覆盖层算位置的公式（`CharacterSprite.updateDomLabelPosition`）：
 *
 * ```ts
 * const screenX = (this.x - worldView.x) * camera.zoom + camera.x;
 * const screenY = (this.y - worldView.y) * camera.zoom + camera.y;
 * ```
 *
 * 这里把 `worldView.x` 换成了 `scrollX`（见 `CameraState` 的说明）。
 */
export function worldToScreen(
  camera: CameraState,
  worldX: number,
  worldY: number,
): { x: number; y: number } {
  return {
    x: (worldX - camera.scrollX) * camera.zoom + camera.viewportX,
    y: (worldY - camera.scrollY) * camera.zoom + camera.viewportY,
  };
}

/** 屏幕坐标 → 世界坐标 —— `worldToScreen` 的逆运算。 */
export function screenToWorld(
  camera: CameraState,
  screenX: number,
  screenY: number,
): { x: number; y: number } {
  return {
    x: (screenX - camera.viewportX) / camera.zoom + camera.scrollX,
    y: (screenY - camera.viewportY) / camera.zoom + camera.scrollY,
  };
}
