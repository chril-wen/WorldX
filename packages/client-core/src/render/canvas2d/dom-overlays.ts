/**
 * DOM 覆盖层渲染器 —— 名牌和对话气泡。
 *
 * ## 为什么是 DOM 而不是 canvas
 *
 * 改造前它们**就是** DOM：`HTMLDivElement` + CSS，画在 canvas 之上
 * （`#label-root`，`z-index: 2`）。
 *
 * 契约把它们单列成 `OverlayItem`（见 `render-model.ts`），
 * 就是因为「用 DOM 还是 canvas 画」是**渲染实现的选择**。
 *
 * 这里选 DOM，理由很实在：**旧实现的 CSS 是现成的观感基准**。
 * 阶段 8.2 的验收标准是「与现在视觉一致」——
 * 把气泡的圆角、阴影、渐变重画成 canvas 图形，
 * 等于凭空引入一堆「哪里不一样」的差异。
 *
 * 用 DOM 的话，CSS **逐字搬过来**，观感自然一致。
 *
 * ## 覆盖层的样式是**渲染实现的事**
 *
 * 契约只给「位置、内容、可见性、缩放」——
 * 圆角、阴影、渐变、字号 clamp 全在这里定。
 *
 * ## 与旧实现的逐字对应
 *
 * | 旧实现 | 这里 |
 * |---|---|
 * | `CharacterSprite.createDomLabel()` | `createLabel()` |
 * | `updateDomLabelStyle()` | `updateLabelStyle()` |
 * | `updateDialogueBubbleStyle()` | `updateBubbleStyle()` |
 * | `updateDomLabelPosition()` | `render()`（位置已由契约算好） |
 */

import type { OverlayItem } from "../render-model.js";
import {
  createCharacterDisplayMetrics,
  type CharacterDisplayMetrics,
} from "../character-metrics.js";

/** 覆盖层渲染器的可选项。 */
export interface OverlayRendererOptions {
  /**
   * 角色的显示度量 —— 用来算名牌和气泡的字号。
   *
   * 契约的 `OverlayItem` 只给了 `zoom`，没给度量 ——
   * 因为度量是**世界单位**的尺寸，跟「画成什么样」有关。
   *
   * 但字号 clamp 的规则（`labelNameWorldSize * zoom` 再 clamp 到 9~20）
   * 是**观感的一部分**，要复刻旧实现就得有度量。
   *
   * 不给就用一个**中性默认**（按 1920×1080 地图算）——
   * 宁可字号差点，也不能整个覆盖层不出现。
   */
  displayMetrics?: CharacterDisplayMetrics;
}

/**
 * 名牌和气泡的 DOM 渲染器。
 *
 * ## 生命周期
 *
 * ```
 * mount(root) → render(overlays) × N → unmount()
 * ```
 *
 * `render` 是**全量替换** —— 每次把当前这批覆盖层重新对上 DOM。
 *
 * 之所以不全量替换而是**复用节点**：
 * 名字牌上的文字变了，如果换节点，CSS 过渡和浏览器的文字渲染缓存都会失效。
 * 所以按「角色 id + 类型」记住节点，只改变化的部分。
 */
export class DomOverlayRenderer {
  private root: HTMLElement | null = null;
  private metrics: CharacterDisplayMetrics;

  /** 名字牌节点 —— 按角色 id 记。 */
  private labels = new Map<string, LabelNodes>();
  /** 气泡节点 —— 按角色 id 记。 */
  private bubbles = new Map<string, BubbleNodes>();

  constructor(options: OverlayRendererOptions = {}) {
    this.metrics = options.displayMetrics ?? defaultDisplayMetrics();
  }

  /** 挂到容器（通常是 `#label-root`）。 */
  mount(root: HTMLElement): void {
    this.root = root;
  }

  /** 卸载 —— 把所有节点摘掉。 */
  unmount(): void {
    for (const nodes of this.labels.values()) nodes.root.remove();
    for (const nodes of this.bubbles.values()) nodes.root.remove();
    this.labels.clear();
    this.bubbles.clear();
    this.root = null;
  }

  /**
   * 渲染一批覆盖层。
   *
   * **不在这一批里的**（角色走了、气泡收了）会被摘掉。
   */
  render(overlays: OverlayItem[]): void {
    const root = this.root;
    if (!root) return;

    const seenLabels = new Set<string>();
    const seenBubbles = new Set<string>();

    for (const overlay of overlays) {
      if (overlay.kind === "character-label") {
        seenLabels.add(overlay.characterId);
        this.renderLabel(root, overlay);
      } else {
        seenBubbles.add(overlay.characterId);
        this.renderBubble(root, overlay);
      }
    }

    // 摘掉这一批里没有的。
    for (const [id, nodes] of this.labels) {
      if (seenLabels.has(id)) continue;
      nodes.root.remove();
      this.labels.delete(id);
    }
    for (const [id, nodes] of this.bubbles) {
      if (seenBubbles.has(id)) continue;
      nodes.root.remove();
      this.bubbles.delete(id);
    }
  }

  /* ── 名牌 ────────────────────────────────────────────────── */

  private renderLabel(root: HTMLElement, overlay: OverlayItem): void {
    let nodes = this.labels.get(overlay.characterId);
    if (!nodes) {
      nodes = createLabel();
      root.appendChild(nodes.root);
      this.labels.set(overlay.characterId, nodes);
    }

    const { name, icon, pill } = nodes;

    if (name.textContent !== overlay.content) {
      name.textContent = overlay.content;
    }

    // 动作图标 —— 没有就藏起来（旧实现是 `display: none`）。
    const iconText = overlay.actionIcon ?? "";
    icon.textContent = iconText;
    icon.style.display = iconText ? "inline-block" : "none";

    // 动作药丸 —— 同上。
    const pillText = overlay.actionLabel ?? "";
    pill.textContent = pillText;
    pill.style.display = pillText ? "block" : "none";

    this.updateLabelStyle(nodes, overlay.zoom);

    // 位置 —— 契约给的是屏幕坐标（已取整）。
    nodes.root.style.left = `${overlay.x}px`;
    nodes.root.style.top = `${overlay.y}px`;
    nodes.root.style.display = overlay.visible ? "flex" : "none";
  }

  /**
   * 名牌的字号 / 间距 —— **逐字搬自**旧 `updateDomLabelStyle()`。
   *
   * 规则：`世界尺寸 × 缩放`，再 clamp。
   */
  private updateLabelStyle(nodes: LabelNodes, zoom: number): void {
    const metrics = this.metrics;
    const safeZoom = Math.max(zoom, 0.01);

    const nameSize = clamp(metrics.labelNameWorldSize * safeZoom, 9, 20);
    const iconSize = clamp(metrics.labelIconWorldSize * safeZoom, 9, 18);
    const gap = clamp(metrics.labelGapWorld * safeZoom, 1, 6);

    nodes.root.style.gap = `${gap}px`;
    nodes.root.style.zIndex = "10";
    nodes.nameRow.style.gap = `${Math.max(2, gap)}px`;
    nodes.name.style.fontSize = `${nameSize}px`;
    nodes.icon.style.fontSize = `${iconSize}px`;

    const pillSize = clamp(metrics.labelNameWorldSize * safeZoom * 0.75, 9, 18);
    nodes.pill.style.fontSize = `${pillSize}px`;
    nodes.pill.style.padding = `${Math.max(2, pillSize * 0.3)}px ${Math.max(6, pillSize * 0.8)}px`;
  }
  /* ── 气泡 ────────────────────────────────────────────────── */

  private renderBubble(root: HTMLElement, overlay: OverlayItem): void {
    let nodes = this.bubbles.get(overlay.characterId);
    if (!nodes) {
      nodes = createBubble();
      root.appendChild(nodes.root);
      this.bubbles.set(overlay.characterId, nodes);
    }

    const hasMain = overlay.content.trim().length > 0;
    const hasInner = (overlay.innerMonologue ?? "").trim().length > 0;

    if (nodes.main.textContent !== overlay.content) {
      nodes.main.textContent = overlay.content;
    }
    nodes.main.style.display = hasMain ? "block" : "none";

    const inner = overlay.innerMonologue ?? "";
    if (nodes.inner.textContent !== inner) {
      nodes.inner.textContent = inner;
    }
    nodes.innerWrap.style.display = hasInner ? "flex" : "none";

    this.updateBubbleStyle(nodes, overlay.zoom);

    nodes.root.style.left = `${overlay.x}px`;
    nodes.root.style.top = `${overlay.y}px`;
    nodes.root.style.display = overlay.visible ? "flex" : "none";
  }

  /**
   * 气泡的样式 —— **逐字搬自**旧 `updateDialogueBubbleStyle()`。
   *
   * 所有数值都是 `世界尺寸 × 缩放` 再 clamp。
   */
  private updateBubbleStyle(nodes: BubbleNodes, zoom: number): void {
    const metrics = this.metrics;
    const safeZoom = Math.max(zoom, 0.01);

    const fontSize = clamp(metrics.bubbleFontSize * safeZoom * 0.93, 11, 26);
    const innerFontSize = clamp(fontSize * 0.75, 9, 20);
    const wrapWidth = Math.max(210, metrics.bubbleWrapWidth * safeZoom * 1.28);
    const padX = clamp(metrics.bubblePadding * safeZoom * 1.1, 10, 24);
    const padY = clamp(metrics.bubblePadding * safeZoom * 0.95, 8, 18);
    const radius = clamp(metrics.bubbleCornerRadius * safeZoom, 8, 20);
    const tail = clamp(metrics.bubbleTailHeight * safeZoom * 1.4, 6, 16);

    nodes.card.style.display = "flex";
    nodes.card.style.flexDirection = "column";
    nodes.card.style.alignItems = "stretch";
    nodes.card.style.maxWidth = `${wrapWidth}px`;
    nodes.card.style.padding = `${padY}px ${padX}px`;
    nodes.card.style.borderRadius = `${radius}px`;
    nodes.card.style.background = "rgba(255,255,255,0.98)";
    nodes.card.style.border = "1px solid rgba(33,40,62,0.08)";
    nodes.card.style.boxShadow =
      "0 10px 28px rgba(8,14,32,0.18), 0 2px 8px rgba(8,14,32,0.08)";

    nodes.main.style.color = "#1e2433";
    nodes.main.style.fontFamily =
      "'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif";
    nodes.main.style.fontWeight = "700";
    nodes.main.style.fontSize = `${fontSize}px`;
    nodes.main.style.lineHeight = "1.33";
    nodes.main.style.whiteSpace = "pre-wrap";
    nodes.main.style.wordBreak = "break-word";
    nodes.main.style.overflowWrap = "anywhere";

    // 只有内心独白时，内独白块不画上边框（跟旧实现一样）。
    const isMonologueOnly = nodes.main.style.display === "none";
    nodes.innerWrap.style.flexDirection = "column";
    nodes.innerWrap.style.gap = `${Math.max(4, padY * 0.35)}px`;
    nodes.innerWrap.style.marginTop = isMonologueOnly
      ? "0"
      : `${Math.max(8, padY * 0.8)}px`;
    nodes.innerWrap.style.padding = `${Math.max(7, padY * 0.6)}px ${Math.max(9, padX * 0.7)}px`;
    nodes.innerWrap.style.borderRadius = `${Math.max(8, radius * 0.75)}px`;
    nodes.innerWrap.style.background =
      "linear-gradient(180deg, rgba(110,123,255,0.08), rgba(110,123,255,0.03))";
    nodes.innerWrap.style.borderTop = isMonologueOnly
      ? "none"
      : "1px solid rgba(110,123,255,0.14)";

    nodes.inner.style.color = "#586079";
    nodes.inner.style.fontFamily =
      "'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif";
    nodes.inner.style.fontSize = `${innerFontSize}px`;
    nodes.inner.style.fontStyle = "italic";
    nodes.inner.style.lineHeight = "1.42";
    nodes.inner.style.whiteSpace = "pre-wrap";
    nodes.inner.style.wordBreak = "break-word";
    nodes.inner.style.overflowWrap = "anywhere";

    nodes.tail.style.width = "0";
    nodes.tail.style.height = "0";
    nodes.tail.style.marginTop = "-1px";
    nodes.tail.style.borderLeft = `${tail}px solid transparent`;
    nodes.tail.style.borderRight = `${tail}px solid transparent`;
    nodes.tail.style.borderTop = `${tail + 2}px solid rgba(255,255,255,0.98)`;
    nodes.tail.style.filter = "drop-shadow(0 3px 4px rgba(8,14,32,0.08))";
  }
}

/* ── DOM 节点 ────────────────────────────────────────────────── */

interface LabelNodes {
  root: HTMLElement;
  nameRow: HTMLElement;
  name: HTMLElement;
  icon: HTMLElement;
  pill: HTMLElement;
}

interface BubbleNodes {
  root: HTMLElement;
  card: HTMLElement;
  main: HTMLElement;
  innerWrap: HTMLElement;
  inner: HTMLElement;
  tail: HTMLElement;
}

/**
 * 造一个名字牌 —— **逐字搬自**旧 `createDomLabel()`。
 *
 * 结构跟旧实现**一模一样**：
 * `root > (nameRow > (name, icon), pill)`
 */
function createLabel(): LabelNodes {
  const root = document.createElement("div");
  root.className = "character-label";

  const nameRow = document.createElement("div");
  nameRow.className = "character-label__name-row";

  const name = document.createElement("div");
  name.className = "character-label__name";

  const icon = document.createElement("span");
  icon.className = "character-label__icon";
  icon.style.display = "none";

  const pill = document.createElement("div");
  pill.className = "character-label__action-pill";
  pill.style.display = "none";

  nameRow.append(name, icon);
  root.append(nameRow, pill);

  return { root, nameRow, name, icon, pill };
}

/**
 * 造一个对话气泡 —— **逐字搬自**旧 `createDomDialogueBubble()`。
 *
 * 结构：`root > (card > (main, innerWrap > inner), tail)`
 */
function createBubble(): BubbleNodes {
  const root = document.createElement("div");
  root.className = "character-dialogue-bubble";
  root.style.position = "absolute";
  root.style.display = "none";
  root.style.flexDirection = "column";
  root.style.alignItems = "center";
  root.style.transform = "translate(-50%, -100%)";
  root.style.pointerEvents = "none";
  root.style.userSelect = "none";
  root.style.zIndex = "40";

  const card = document.createElement("div");
  const main = document.createElement("div");
  const innerWrap = document.createElement("div");
  const inner = document.createElement("div");
  const tail = document.createElement("div");

  innerWrap.style.display = "none";
  innerWrap.append(inner);
  card.append(main, innerWrap);
  root.append(card, tail);

  return { root, card, main, innerWrap, inner, tail };
}

/* ── 工具 ────────────────────────────────────────────────────── */

/** 限幅 —— 跟 Phaser 的 `Math.Clamp` 一个语义。 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * 中性的默认度量 —— 按一张 **1920×1080** 的地图算。
 *
 * 只在「调用方没给度量」时用。
 *
 * ## 为什么不用零值
 *
 * 度量里的字段是**乘出来的**（`世界尺寸 × 缩放`）——
 * 零值乘出来还是零，字号就成了 0px，名牌直接消失。
 *
 * 与其手写一份「看起来合理」的常量，不如走**同一个工厂**
 * （`createCharacterDisplayMetrics`）—— 那才是度量的唯一来源，
 * 跟 builder 用的是同一份代码，数字自然对得上。
 */
function defaultDisplayMetrics(): CharacterDisplayMetrics {
  return createCharacterDisplayMetrics(1920, 1080);
}
