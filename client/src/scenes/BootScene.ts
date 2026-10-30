import Phaser from "phaser";
import type { CharacterAsset } from "../assets/character-assets";

const MAP_TMJ_PATH = "/assets/map/06-final.tmj";
const MAP_BACKGROUND_PATH = "/assets/map/06-background.png";

/**
 * 启动场景 —— 加载地图底图和角色贴图，然后进 `WorldScene`。
 *
 * ## 贴图集的格子尺寸是**查出来的**，不是写死的
 *
 * 贴图集是 6×5 的网格，但格子大小**跟着图片尺寸走**：
 *
 * - 老贴图集 1024×1024 → 格子 **170×204**
 * - 新贴图集 1048×1048 → 格子 **174×209**
 *
 * 写死 `170×204` 的话，每一行的窗口都会**往上偏**，越偏越多
 * （行 0 偏 27px，行 3 偏 52px）。到了站桩帧那一行，
 * 窗口顶部截到的是**上一行的脚**，窗口底部把角色自己的**脚切掉** ——
 * 画出来就是「脚在头上」。
 *
 * ## 为什么格子尺寸是**传进来**的，而不是这里查
 *
 * Phaser 的 `preload()` 必须**同步**返回。
 *
 * `SceneManager.bootScene()` 调完 `preload()` 就立刻 `loader.start()`，
 * 而 `preload()` 一旦是 `async` 的，Phaser **不会等**：
 * 队列可能一个文件都没有 → `loadComplete()` 立刻触发 →
 * `SceneEvents.UPDATE` 被摘掉 → **后补进队列的文件永远不会被下载**。
 *
 * 所以查 metadata 必须发生在**游戏启动之前**
 * （见 `assets/character-assets.ts` 的说明）。
 */
export class BootScene extends Phaser.Scene {
  /**
   * 角色贴图资源 —— **必须在 `preload()` 之前**就查好。
   *
   * 由 `main.tsx` 在 `new Phaser.Game()` 之前填好。
   */
  static characterAssets: CharacterAsset[] = [];

  constructor() {
    super("BootScene");
  }

  preload() {
    const w = this.cameras.main.width;
    const h = this.cameras.main.height;

    this.add.text(w / 2, h / 2 - 20, "OWN-World", {
      fontSize: "24px",
      color: "#e0e0e0",
      fontFamily: "Arial",
    }).setOrigin(0.5);

    const barW = 320;
    const barY = h / 2 + 20;
    const barX = w / 2 - barW / 2;

    const barFill = this.add.rectangle(barX, barY, 1, 6, 0x74b9ff).setOrigin(0, 0);

    const statusText = this.add.text(w / 2, barY + 24, "Loading...", {
      fontSize: "12px",
      color: "#888",
      fontFamily: "Arial",
    }).setOrigin(0.5);

    this.load.on("progress", (value: number) => {
      try {
        barFill.width = Math.max(1, barW * value);
        statusText.setText(`Loading... ${Math.round(value * 100)}%`);
      } catch (_) { /* protect the loader pipeline */ }
    });

    this.load.json("world-map", MAP_TMJ_PATH);
    this.load.image("world-base", MAP_BACKGROUND_PATH);

    /**
     * 角色贴图集 —— 格子大小**已经查好了**。
     *
     * ⚠ **这里不能 `await`** —— `preload()` 一旦异步，
     * Phaser 就不等它，后补进队列的贴图就永远不会被下载。
     * 详见类注释。
     */
    for (const asset of BootScene.characterAssets) {
      this.load.spritesheet(
        asset.id,
        `/assets/characters/${asset.id}/spritesheet.png`,
        {
          frameWidth: asset.frameWidth,
          frameHeight: asset.frameHeight,
        },
      );
    }
  }

  create() {
    for (const key of this.textures.getTextureKeys()) {
      if (key === "world-base" || key.startsWith("char_")) {
        this.textures.get(key).setFilter(Phaser.Textures.FilterMode.LINEAR);
      }
    }
    console.log("[BootScene] Loading complete, starting WorldScene");
    this.scene.start("WorldScene");
  }
}
