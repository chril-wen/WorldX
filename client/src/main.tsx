import "./i18n";
import Phaser from "phaser";
import { createRoot } from "react-dom/client";
import { BootScene } from "./scenes/BootScene";
import { WorldScene } from "./scenes/WorldScene";
import { App } from "./ui/App";
import { EventBus } from "./EventBus";
import { loadCharacterAssets } from "./assets/character-assets";

/**
 * 启动顺序 —— **先起 UI，再查角色资源，最后建 Phaser 游戏**。
 *
 * ## 为什么角色资源不能放进 `preload()`
 *
 * Phaser 的 `preload()` 必须**同步**返回。
 * `SceneManager.bootScene()` 调完 `preload()` 就立刻 `loader.start()`，
 * 而 `preload()` 一旦是 `async` 的，Phaser **不会等** ——
 * 队列可能还是空的，于是 `loadComplete()` 立刻触发，
 * `SceneEvents.UPDATE` 被摘掉，**后补进队列的文件永远不会被下载**。
 *
 * 角色贴图的格子尺寸（170×204 还是 174×209）得先查清楚 ——
 * 查的过程要发 HTTP 请求，天然是异步的。
 *
 * 所以：**查在游戏外面**，查完把结果交给 `BootScene`。
 *
 * ## 为什么 UI 先起
 *
 * UI 面板层（React）**不依赖**贴图 —— 它要的是角色清单，
 * 那个 API 自己会取。让 UI 先画出来，用户不用干等贴图。
 *
 * 详见 `assets/character-assets.ts` 的说明。
 */
async function bootstrap(): Promise<void> {
  const uiRoot = document.getElementById("ui-root")!;
  createRoot(uiRoot).render(<App eventBus={EventBus.instance} />);

  const assets = await loadCharacterAssets();
  BootScene.characterAssets = assets.characters;

  new Phaser.Game({
    type: Phaser.AUTO,
    width: window.innerWidth,
    height: window.innerHeight,
    parent: "game-root",
    transparent: true,
    render: { antialias: true, roundPixels: false },
    scale: { mode: Phaser.Scale.RESIZE },
    scene: [BootScene, WorldScene],
  });
}

void bootstrap();
