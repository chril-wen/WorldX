/**
 * 角色贴图资源 —— **在 Phaser 启动之前**查好格子尺寸。
 *
 * ## 为什么要在游戏启动前查
 *
 * Phaser 的 loader 是「同步排队、异步下载」：
 * `SceneManager.bootScene()` 调完 `preload()` 就立刻 `loader.start()`。
 *
 * 而 `preload()` 一旦是 `async` 的，它**返回的是 promise** ——
 * Phaser 不会等，直接就 `start()` 了。这时候队列里可能一个文件都没有，
 * 于是 `loadComplete()` 立刻触发：
 *
 * ```js
 * // LoaderPlugin.js
 * loadComplete: function () {
 *     this.systems.events.off(SceneEvents.UPDATE, this.update, this);
 *     ...
 * }
 * ```
 *
 * `SceneEvents.UPDATE` 被摘掉之后，**后补进队列的文件永远不会被下载** ——
 * `addFile()` 只在 `isLoading()` 为真时才 `totalToLoad++`，
 * 而那时的状态已经是 `LOADER_COMPLETE`。
 *
 * 所以：**排队前必须就知道所有参数**。
 * 这就是为什么 metadata 要在**游戏外面**查 —— 查完再 `new Phaser.Game()`。
 *
 * ## 改造前就有的坑
 *
 * 改造前的 `BootScene.preload()` 也是 `async` 的（它 `await` 了角色清单），
 * 所以这个 race **本来就存在** —— 只是地图底图够大，下载够慢，
 * 角色清单通常能在底图下载完之前回来，**碰巧**没出事。
 *
 * 现在多查 21 份 metadata，「碰巧」就不成立了。
 * 所以这不是新引入的 bug，是**把一个一直存在的 race 暴露出来**。
 *
 * ## 格子尺寸从哪来
 *
 * 贴图集是 6×5 的网格，但**格子多大跟着图片尺寸走**：
 *
 * - 老贴图集 1024×1024 → 格子 **170×204**
 * - 新贴图集 1048×1048 → 格子 **174×209**
 *
 * 写死 170×204 会让每一行的窗口都往上偏（越偏越多），
 * 到站桩帧那一行，窗口顶部截到的是上一行的脚、底部把角色的脚切掉 ——
 * 画出来就是「**脚在头上**」。
 *
 * 真值在生成器写下的 `metadata.json` 里 —— 读它，读不到才回落。
 */

import {
  DEFAULT_SPRITE_FRAME_HEIGHT,
  DEFAULT_SPRITE_FRAME_WIDTH,
  characterMetadataUrl,
  parseCharacterSpriteMetadata,
  type CharacterSpriteMetadata,
} from "@own-world/client-core";

/** 一个角色的贴图资源。 */
export interface CharacterAsset {
  /** 角色 id —— 也是 Phaser 里的贴图 key。 */
  id: string;
  /** 贴图集一格的宽（像素）。 */
  frameWidth: number;
  /** 贴图集一格的高（像素）。 */
  frameHeight: number;
  /** 读到的 `metadata.json`（读不到就是 `null`）。 */
  metadata: CharacterSpriteMetadata | null;
}

/** 全部角色的贴图资源。 */
export interface CharacterAssets {
  characters: CharacterAsset[];
}

/**
 * 读角色清单（`/api/characters`）。
 *
 * **读不到就返回空数组** —— 没有角色也能进游戏（只是没人）。
 */
async function fetchCharacterIds(): Promise<string[]> {
  try {
    const response = await fetch("/api/characters");
    if (!response.ok) return [];
    const characters: { id?: unknown }[] = await response.json();
    return characters
      .map((c) => String(c.id ?? ""))
      .filter((id) => id.length > 0);
  } catch {
    return [];
  }
}

/**
 * 读一个角色的 `metadata.json`。
 *
 * **读不到就返回 `null`** —— metadata 是「锦上添花」，
 * 没有它还有兜底值，不该在这儿卡住。
 */
async function fetchSpriteMetadata(
  characterId: string,
): Promise<CharacterSpriteMetadata | null> {
  try {
    const response = await fetch(characterMetadataUrl(characterId));
    if (!response.ok) return null;
    return parseCharacterSpriteMetadata(await response.json());
  } catch {
    return null;
  }
}

/**
 * 把所有角色的贴图资源查好。
 *
 * ## 为什么**并行**
 *
 * 21 个角色就是 21 次 HTTP 往返。串行的话启动要多等好几秒 ——
 * 并行就只是一次往返的延迟。
 */
export async function loadCharacterAssets(): Promise<CharacterAssets> {
  const ids = await fetchCharacterIds();
  if (ids.length === 0) {
    return { characters: [] };
  }

  const characters = await Promise.all(
    ids.map(async (id): Promise<CharacterAsset> => {
      const metadata = await fetchSpriteMetadata(id);
      if (!metadata) {
        // 没有 metadata 就用兜底值 —— 至少是个已知能用的数。
        console.warn(
          `[character-assets] ${id} 没有 metadata.json —— 用兜底格子尺寸 ` +
            `${DEFAULT_SPRITE_FRAME_WIDTH}×${DEFAULT_SPRITE_FRAME_HEIGHT}`,
        );
        return {
          id,
          frameWidth: DEFAULT_SPRITE_FRAME_WIDTH,
          frameHeight: DEFAULT_SPRITE_FRAME_HEIGHT,
          metadata: null,
        };
      }
      return {
        id,
        frameWidth: metadata.frameWidth,
        frameHeight: metadata.frameHeight,
        metadata,
      };
    }),
  );

  return { characters };
}
