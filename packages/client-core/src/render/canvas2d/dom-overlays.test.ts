/**
 * DOM 覆盖层渲染器的单测。
 *
 * ## 这一层在验什么
 *
 * 名牌和气泡**不是 canvas 图元** —— 它们的观感是 CSS。
 *
 * 所以这里验三件事：
 *
 * 1. **位置对不对** —— 契约给的屏幕坐标有没有落到 DOM 上
 * 2. **可见性对不对** —— 视口外的名牌要藏起来
 * 3. **字号对不对** —— `世界尺寸 × 缩放` 再 clamp，clamp 区间跟旧实现一样
 *
 * 「位置对不对」的**来源**由 `scene-builder.ab.test.ts` 保证
 * （那边比的是旧实现）；这里验的是「渲染实现有没有把契约给的值用对」。
 *
 * ## 为什么用假 DOM
 *
 * Node 里没有 DOM，而 jsdom 会引入一整套浏览器语义 ——
 * 这里要验的只是「style 写了什么值」，不需要真布局。
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DomOverlayRenderer } from "./dom-overlays.js";
import { createCharacterDisplayMetrics } from "../character-metrics.js";
import type { OverlayItem } from "../render-model.js";

/* ── 最小 DOM ────────────────────────────────────────────────── */

/** 一个只记 style 和孩子的假元素。 */
interface FakeElement {
  style: Record<string, string>;
  className: string;
  textContent: string;
  children: FakeElement[];
  /** 父节点 —— 真 DOM 的 `remove()` 是从父节点里摘掉自己。 */
  parent: FakeElement | null;
  appendChild(child: FakeElement): FakeElement;
  append(...children: FakeElement[]): void;
  remove(): void;
}

function makeElement(): FakeElement {
  const element: FakeElement = {
    style: {} as Record<string, string>,
    className: "",
    textContent: "",
    children: [] as FakeElement[],
    parent: null,
    appendChild(child: FakeElement) {
      child.parent?.removeChildInternal(child);
      this.children.push(child);
      child.parent = this;
      return child;
    },
    append(...children: FakeElement[]) {
      for (const child of children) this.appendChild(child);
    },
    remove() {
      this.parent?.removeChildInternal(this);
      this.parent = null;
    },
    removeChildInternal(child: FakeElement) {
      const index = this.children.indexOf(child);
      if (index >= 0) this.children.splice(index, 1);
      child.parent = null;
    },
  };
  return element;
}

/** 装一个最小 `document` 全局。 */
function installDom() {
  const previous = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = {
    createElement: () => makeElement(),
    getElementById: () => makeElement(),
    body: makeElement(),
  };
  return {
    restore: () => {
      if (previous === undefined) {
        delete (globalThis as { document?: unknown }).document;
      } else {
        (globalThis as { document?: unknown }).document = previous;
      }
    },
  };
}

const dom = installDom();

beforeAll(() => {
  /* DOM 已在模块加载时装好 */
});

afterAll(() => {
  dom.restore();
});

/* ── 测试辅助 ────────────────────────────────────────────────── */

/** 按 class 名在一个元素树里找**（深度优先）。 */
function findByClass(root: FakeElement, className: string): FakeElement | null {
  if (root.className === className) return root;
  for (const child of root.children) {
    const found = findByClass(child, className);
    if (found) return found;
  }
  return null;
}

/** 按 class 名找**所有**匹配的元素。 */
function findAllByClass(root: FakeElement, className: string): FakeElement[] {
  const found: FakeElement[] = [];
  if (root.className === className) found.push(root);
  for (const child of root.children) {
    found.push(...findAllByClass(child, className));
  }
  return found;
}

/** 造一个覆盖层根容器。 */
function makeRoot(): FakeElement {
  return makeElement();
}

const METRICS = createCharacterDisplayMetrics(4000, 3000);

/* ── 名牌 ────────────────────────────────────────────────────── */

describe("名字牌", () => {
  it("位置写在 left / top 上 —— 契约给的是屏幕坐标", () => {
    const root = makeRoot();
    const renderer = new DomOverlayRenderer({ displayMetrics: METRICS });
    renderer.mount(root as unknown as HTMLElement);

    renderer.render([
      {
        kind: "character-label",
        characterId: "c1",
        x: 123,
        y: 456,
        content: "小明",
        zoom: 1,
        visible: true,
      },
    ]);

    const label = findByClass(root, "character-label")!;
    expect(label.style.left).toBe("123px");
    expect(label.style.top).toBe("456px");
    expect(label.style.display).toBe("flex");
  });

  it("不可见时藏起来", () => {
    const root = makeRoot();
    const renderer = new DomOverlayRenderer({ displayMetrics: METRICS });
    renderer.mount(root as unknown as HTMLElement);

    renderer.render([
      {
        kind: "character-label",
        characterId: "c1",
        x: 0,
        y: 0,
        content: "小明",
        zoom: 1,
        visible: false,
      },
    ]);

    const label = findByClass(root, "character-label")!;
    expect(label.style.display).toBe("none");
  });

  it("名字写进 name 元素", () => {
    const root = makeRoot();
    const renderer = new DomOverlayRenderer({ displayMetrics: METRICS });
    renderer.mount(root as unknown as HTMLElement);

    renderer.render([
      {
        kind: "character-label",
        characterId: "c1",
        x: 0,
        y: 0,
        content: "小明",
        zoom: 1,
        visible: true,
      },
    ]);

    expect(findByClass(root, "character-label__name")!.textContent).toBe("小明");
  });

  it("没有动作图标时藏起来 —— 旧实现就是 display:none", () => {
    const root = makeRoot();
    const renderer = new DomOverlayRenderer({ displayMetrics: METRICS });
    renderer.mount(root as unknown as HTMLElement);

    renderer.render([
      {
        kind: "character-label",
        characterId: "c1",
        x: 0,
        y: 0,
        content: "小明",
        zoom: 1,
        visible: true,
      },
    ]);

    expect(findByClass(root, "character-label__icon")!.style.display).toBe("none");
    expect(findByClass(root, "character-label__action-pill")!.style.display).toBe("none");
  });

  it("有动作图标和药丸时显示出来", () => {
    const root = makeRoot();
    const renderer = new DomOverlayRenderer({ displayMetrics: METRICS });
    renderer.mount(root as unknown as HTMLElement);

    renderer.render([
      {
        kind: "character-label",
        characterId: "c1",
        x: 0,
        y: 0,
        content: "小明",
        actionIcon: "🍳",
        actionLabel: "做饭",
        zoom: 1,
        visible: true,
      },
    ]);

    const icon = findByClass(root, "character-label__icon")!;
    expect(icon.textContent).toBe("🍳");
    expect(icon.style.display).toBe("inline-block");

    const pill = findByClass(root, "character-label__action-pill")!;
    expect(pill.textContent).toBe("做饭");
    expect(pill.style.display).toBe("block");
  });

  it("字号 = 世界尺寸 × 缩放，再 clamp 到 9~20", () => {
    const root = makeRoot();
    const renderer = new DomOverlayRenderer({ displayMetrics: METRICS });
    renderer.mount(root as unknown as HTMLElement);

    // 缩放很小 → 落到下限 9
    renderer.render([
      {
        kind: "character-label",
        characterId: "c1",
        x: 0,
        y: 0,
        content: "小明",
        zoom: 0.05,
        visible: true,
      },
    ]);
    const name = findByClass(root, "character-label__name")!;
    const small = Number.parseFloat(name.style.fontSize);
    expect(small).toBe(9);

    // 缩放很大 → 落到上限 20
    renderer.render([
      {
        kind: "character-label",
        characterId: "c1",
        x: 0,
        y: 0,
        content: "小明",
        zoom: 100,
        visible: true,
      },
    ]);
    const large = Number.parseFloat(name.style.fontSize);
    expect(large).toBe(20);
  });

  it("中间缩放时按比例算", () => {
    const root = makeRoot();
    const renderer = new DomOverlayRenderer({ displayMetrics: METRICS });
    renderer.mount(root as unknown as HTMLElement);

    renderer.render([
      {
        kind: "character-label",
        characterId: "c1",
        x: 0,
        y: 0,
        content: "小明",
        zoom: 0.5,
        visible: true,
      },
    ]);

    const expected = Math.min(
      20,
      Math.max(9, METRICS.labelNameWorldSize * 0.5),
    );
    const name = findByClass(root, "character-label__name")!;
    expect(Number.parseFloat(name.style.fontSize)).toBe(expected);
  });
});

/* ── 气泡 ────────────────────────────────────────────────────── */

describe("对话气泡", () => {
  it("位置写在 left / top 上", () => {
    const root = makeRoot();
    const renderer = new DomOverlayRenderer({ displayMetrics: METRICS });
    renderer.mount(root as unknown as HTMLElement);

    renderer.render([
      {
        kind: "dialogue-bubble",
        characterId: "c1",
        x: 200,
        y: 300,
        content: "你好",
        zoom: 1,
        visible: true,
      },
    ]);

    const bubble = findByClass(root, "character-dialogue-bubble")!;
    expect(bubble.style.left).toBe("200px");
    expect(bubble.style.top).toBe("300px");
    expect(bubble.style.display).toBe("flex");
  });

  it("主文本和内心独白分开处理", () => {
    const root = makeRoot();
    const renderer = new DomOverlayRenderer({ displayMetrics: METRICS });
    renderer.mount(root as unknown as HTMLElement);

    renderer.render([
      {
        kind: "dialogue-bubble",
        characterId: "c1",
        x: 0,
        y: 0,
        content: "你好",
        innerMonologue: "其实我有点紧张",
        zoom: 1,
        visible: true,
      },
    ]);

    const bubble = findByClass(root, "character-dialogue-bubble")!;
    const main = findAllByClass(bubble, "").find(
      (el) => el.textContent === "你好",
    )!;
    expect(main.style.display).toBe("block");

    const inner = findAllByClass(bubble, "").find(
      (el) => el.textContent === "其实我有点紧张",
    )!;
    expect(inner.style.display).not.toBe("none");
  });

  it("没有内心独白时藏起内独白块", () => {
    const root = makeRoot();
    const renderer = new DomOverlayRenderer({ displayMetrics: METRICS });
    renderer.mount(root as unknown as HTMLElement);

    renderer.render([
      {
        kind: "dialogue-bubble",
        characterId: "c1",
        x: 0,
        y: 0,
        content: "你好",
        zoom: 1,
        visible: true,
      },
    ]);

    const bubble = findByClass(root, "character-dialogue-bubble")!;
    // card > (main, innerWrap > inner)
    const card = bubble.children[0];
    const innerWrap = card.children[1];
    expect(innerWrap.style.display).toBe("none");
  });

  it("不可见时藏起来", () => {
    const root = makeRoot();
    const renderer = new DomOverlayRenderer({ displayMetrics: METRICS });
    renderer.mount(root as unknown as HTMLElement);

    renderer.render([
      {
        kind: "dialogue-bubble",
        characterId: "c1",
        x: 0,
        y: 0,
        content: "你好",
        zoom: 1,
        visible: false,
      },
    ]);

    const bubble = findByClass(root, "character-dialogue-bubble")!;
    expect(bubble.style.display).toBe("none");
  });
});

/* ── 生命周期 ────────────────────────────────────────────────── */

describe("生命周期", () => {
  it("这一批里没有的覆盖层会被摘掉", () => {
    const root = makeRoot();
    const renderer = new DomOverlayRenderer({ displayMetrics: METRICS });
    renderer.mount(root as unknown as HTMLElement);

    renderer.render([
      {
        kind: "character-label",
        characterId: "c1",
        x: 0,
        y: 0,
        content: "小明",
        zoom: 1,
        visible: true,
      },
    ]);
    expect(findAllByClass(root, "character-label").length).toBe(1);

    renderer.render([]);
    expect(findAllByClass(root, "character-label").length).toBe(0);
  });

  it("节点被复用 —— 名字变了不换节点", () => {
    const root = makeRoot();
    const renderer = new DomOverlayRenderer({ displayMetrics: METRICS });
    renderer.mount(root as unknown as HTMLElement);

    renderer.render([
      {
        kind: "character-label",
        characterId: "c1",
        x: 0,
        y: 0,
        content: "小明",
        zoom: 1,
        visible: true,
      },
    ]);
    const first = findByClass(root, "character-label")!;

    renderer.render([
      {
        kind: "character-label",
        characterId: "c1",
        x: 0,
        y: 0,
        content: "小红",
        zoom: 1,
        visible: true,
      },
    ]);
    const second = findByClass(root, "character-label")!;

    expect(second).toBe(first);
    expect(findByClass(root, "character-label__name")!.textContent).toBe("小红");
  });

  it("unmount 之后所有节点都被摘掉", () => {
    const root = makeRoot();
    const renderer = new DomOverlayRenderer({ displayMetrics: METRICS });
    renderer.mount(root as unknown as HTMLElement);

    renderer.render([
      {
        kind: "character-label",
        characterId: "c1",
        x: 0,
        y: 0,
        content: "小明",
        zoom: 1,
        visible: true,
      },
    ]);
    renderer.unmount();

    expect(findAllByClass(root, "character-label").length).toBe(0);
  });
});
