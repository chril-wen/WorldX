/**
 * 「格子尺寸从哪来」的单测。
 *
 * ## 为什么这个要测
 *
 * 这是**一个静默 bug** 的修复。
 *
 * 贴图集是 6×5 的网格，格子大小**跟着图片尺寸走**：
 *
 * | 贴图集 | 图片尺寸 | 真格子 |
 * |---|---|---|
 * | 老的（`library/`） | 1024×1024 | **170×204** |
 * | 新的（`output/`） | 1048×1048 | **174×209** |
 *
 * 写死 170×204 → 每一行的窗口都往上偏，越偏越多
 * （行 0 偏 27px，行 3 偏 52px）→ 站桩帧的窗口顶部截到
 * **上一行的脚**、底部把**自己的脚切掉** → 「脚在头上」。
 *
 * 而且这个 bug **不报错** —— 图照样画出来，只是画错了。
 * 所以只能靠测试锁住。
 *
 * ## 优先级不能倒
 *
 * ```
 * 显式指定  >  metadata.json  >  按图算  >  170×204
 * ```
 *
 * 「按图算」放在 metadata **后面** 是有讲究的：
 * 生成器已经把真值写进 metadata 了，metadata 是**权威**；
 * 按图算只是 metadata 读不到时的**等价替代**（同一个公式）。
 */

import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SPRITE_FRAME_HEIGHT,
  DEFAULT_SPRITE_FRAME_WIDTH,
  characterMetadataUrl,
  deriveSpriteFrameSize,
  loadCharacterSpriteFrameSize,
  parseCharacterSpriteMetadata,
  resolveSpriteFrameSize,
  type CharacterSpriteMetadata,
} from "./sprite-metadata.js";

describe("characterMetadataUrl", () => {
  it("指向 server 挂载的角色目录", () => {
    expect(characterMetadataUrl("char_123")).toBe(
      "/assets/characters/char_123/metadata.json",
    );
  });
});

describe("parseCharacterSpriteMetadata", () => {
  it("读出生成器写的真值", () => {
    const parsed = parseCharacterSpriteMetadata({
      id: "char_1",
      name: "沈四娘",
      frameWidth: 174,
      frameHeight: 209,
      columns: 6,
      rows: 5,
      animations: { "idle-front": { frame: 18 } },
    });
    expect(parsed).toEqual({
      frameWidth: 174,
      frameHeight: 209,
      columns: 6,
      rows: 5,
    });
  });

  it("老贴图集的 metadata（170×204）也认", () => {
    const parsed = parseCharacterSpriteMetadata({
      frameWidth: 170,
      frameHeight: 204,
      columns: 6,
      rows: 5,
    });
    expect(parsed?.frameWidth).toBe(170);
    expect(parsed?.frameHeight).toBe(204);
  });

  /**
   * metadata 是**外部产物** —— 可能来自旧版本，可能被人手改过。
   * 字段缺失或类型不对时**不能炸**，回落到别的途径就好。
   */
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["字符串", "not an object"],
    ["数字", 42],
    ["空对象", {}],
  ])("%s → null", (_label, raw) => {
    expect(parseCharacterSpriteMetadata(raw)).toBeNull();
  });

  it("frameWidth 缺失 → null（不猜）", () => {
    expect(
      parseCharacterSpriteMetadata({ frameHeight: 209, columns: 6, rows: 5 }),
    ).toBeNull();
  });

  it("frameWidth 是 0 或负数 → null", () => {
    expect(parseCharacterSpriteMetadata({ frameWidth: 0, frameHeight: 209 })).toBeNull();
    expect(
      parseCharacterSpriteMetadata({ frameWidth: -10, frameHeight: 209 }),
    ).toBeNull();
  });

  it("frameHeight 缺失 → null", () => {
    expect(parseCharacterSpriteMetadata({ frameWidth: 174 })).toBeNull();
  });

  it("columns/rows 缺失或非法 → 用默认的 6×5", () => {
    const parsed = parseCharacterSpriteMetadata({
      frameWidth: 174,
      frameHeight: 209,
    });
    expect(parsed?.columns).toBe(6);
    expect(parsed?.rows).toBe(5);
  });

  it("columns/rows 是 0 → 用默认值", () => {
    const parsed = parseCharacterSpriteMetadata({
      frameWidth: 174,
      frameHeight: 209,
      columns: 0,
      rows: -3,
    });
    expect(parsed?.columns).toBe(6);
    expect(parsed?.rows).toBe(5);
  });

  it("小数取整", () => {
    const parsed = parseCharacterSpriteMetadata({
      frameWidth: 174.9,
      frameHeight: 209.4,
    });
    expect(parsed?.frameWidth).toBe(174);
    expect(parsed?.frameHeight).toBe(209);
  });
});

describe("deriveSpriteFrameSize", () => {
  /**
   * 这个公式**逐字抄自生成器**（`generators/character/src/utils/sprite-meta.mjs`
   * 的 `buildMetadata`）—— 所以它不是「猜网格」。
   */
  it("跟生成器一个公式：floor(图宽/列数) × floor(图高/行数)", () => {
    expect(deriveSpriteFrameSize(1024, 1024)).toEqual({
      frameWidth: 170,
      frameHeight: 204,
    });
    expect(deriveSpriteFrameSize(1048, 1048)).toEqual({
      frameWidth: 174,
      frameHeight: 209,
    });
  });

  it("网格形状可以显式给", () => {
    expect(deriveSpriteFrameSize(1048, 1048, 6, 5)).toEqual({
      frameWidth: 174,
      frameHeight: 209,
    });
  });
});

describe("resolveSpriteFrameSize", () => {
  it("显式指定最高优先", () => {
    expect(
      resolveSpriteFrameSize({
        explicit: { frameWidth: 100, frameHeight: 100 },
        metadata: { frameWidth: 174, frameHeight: 209, columns: 6, rows: 5 },
        imageWidth: 1048,
        imageHeight: 1048,
      }),
    ).toEqual({ frameWidth: 100, frameHeight: 100 });
  });

  it("metadata 优先于「按图算」", () => {
    expect(
      resolveSpriteFrameSize({
        metadata: { frameWidth: 174, frameHeight: 209, columns: 6, rows: 5 },
        imageWidth: 1024,
        imageHeight: 1024,
      }),
    ).toEqual({ frameWidth: 174, frameHeight: 209 });
  });

  it("metadata 读不到就按图算", () => {
    expect(
      resolveSpriteFrameSize({ imageWidth: 1048, imageHeight: 1048 }),
    ).toEqual({ frameWidth: 174, frameHeight: 209 });
  });

  it("都没有 → 兜底 170×204", () => {
    expect(resolveSpriteFrameSize({})).toEqual({
      frameWidth: DEFAULT_SPRITE_FRAME_WIDTH,
      frameHeight: DEFAULT_SPRITE_FRAME_HEIGHT,
    });
  });

  it("显式指定里有 0 → 当没有，继续往下找", () => {
    expect(
      resolveSpriteFrameSize({
        explicit: { frameWidth: 0, frameHeight: 0 },
        imageWidth: 1048,
        imageHeight: 1048,
      }),
    ).toEqual({ frameWidth: 174, frameHeight: 209 });
  });

  it("图片尺寸非法 → 兜底", () => {
    expect(
      resolveSpriteFrameSize({ imageWidth: 0, imageHeight: 1048 }),
    ).toEqual({
      frameWidth: DEFAULT_SPRITE_FRAME_WIDTH,
      frameHeight: DEFAULT_SPRITE_FRAME_HEIGHT,
    });
  });
});

describe("loadCharacterSpriteFrameSize", () => {
  it("metadata 有就用它", async () => {
    const metadata: CharacterSpriteMetadata = {
      frameWidth: 174,
      frameHeight: 209,
      columns: 6,
      rows: 5,
    };
    const imageSize = vi.fn();

    const size = await loadCharacterSpriteFrameSize("char_1", {
      metadata: async () => metadata,
      imageSize,
    });

    expect(size).toEqual({ frameWidth: 174, frameHeight: 209 });
    // metadata 有了就**不用**再拿图片尺寸 —— 少一次请求。
    expect(imageSize).not.toHaveBeenCalled();
  });

  it("metadata 没有 → 按图算", async () => {
    const size = await loadCharacterSpriteFrameSize("char_1", {
      metadata: async () => null,
      imageSize: async () => ({ width: 1048, height: 1048 }),
    });
    expect(size).toEqual({ frameWidth: 174, frameHeight: 209 });
  });

  it("metadata 抛异常 → 往下走，不炸", async () => {
    const size = await loadCharacterSpriteFrameSize("char_1", {
      metadata: async () => {
        throw new Error("网络炸了");
      },
      imageSize: async () => ({ width: 1024, height: 1024 }),
    });
    expect(size).toEqual({ frameWidth: 170, frameHeight: 204 });
  });

  it("什么都没有 → 兜底 170×204", async () => {
    const size = await loadCharacterSpriteFrameSize("char_1", {
      metadata: async () => null,
    });
    expect(size).toEqual({
      frameWidth: DEFAULT_SPRITE_FRAME_WIDTH,
      frameHeight: DEFAULT_SPRITE_FRAME_HEIGHT,
    });
  });
});
