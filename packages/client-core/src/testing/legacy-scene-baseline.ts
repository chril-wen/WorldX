/**
 * 阶段 8.1 的 A/B 基准 —— 从 **git 历史**里提取改造前的 Phaser 实现。
 *
 * ## 为什么不是把基准代码存在仓库里
 *
 * 阶段 5 踩过这条坑：基准原来是仓库里的一份代码副本
 * （`.legacy-baseline/`），后来改成从 git 提取。
 *
 * 副本的坏处是**仓库里多一份重复代码** —— 改实现的人得记得基准也要改，
 * 忘了 A/B 就变成自证清白。从 git 提取就没有这个问题：
 * **基准永远是那个 commit 里的字面实现**，没人能「顺手改一下基准」。
 *
 * ## 基准是哪个 commit
 *
 * `29a5eee` —— 「A/B 基准改成从 git 历史提取」那次提交。
 *
 * 选它的理由：它**就是任务指定的基准**，而且此时
 * `WorldScene` / `CharacterSprite` / `game-config`
 * 就是「阶段 8.0（渲染契约）之前」的逐字实现 ——
 * 阶段 8.0 只加了契约类型，**一个字都没动渲染层**。
 *
 * （`29a5eee` 之后的 `cdcae51` 只改了预览配置，
 * 渲染层三个文件逐字相同 —— 见 `git diff 29a5eee cdcae51 -- client/src/scenes/...`。）
 *
 * ## 提取出来的东西怎么跑
 *
 * 提取的文件里 `import Phaser from "phaser"` —— 真 Phaser 在 node 里
 * 跑不起来（要 canvas、要 DOM）。
 *
 * 所以提取时把 `phaser` 的 import **改写成测试替身**
 * （见 `phaser-stub.ts`）—— 替身只把「画到 GPU」换成「记到数组」，
 * **位置算术一个字都没改**。
 *
 * 被 A/B 检验的那段逻辑因此是**逐字的老代码**。
 *
 * ## 拿不到基准怎么办
 *
 * **跳过，不红。** 基准是辅助验证：拿不到它说明「这次没做这项验证」，
 * 不是「产品坏了」。
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 仓库根 —— 从这个文件往上三层（src → client-core → packages → 根）。 */
const REPO_ROOT = path.resolve(HERE, "../../..");

/**
 * 改造前的 commit —— 阶段 8.0（渲染契约）之前。
 *
 * 任务指定的是 `29a5eee`；它之后的 `cdcae51` 只改了预览配置，
 * 渲染层文件逐字相同，所以两者等价。
 */
export const LEGACY_SCENE_COMMIT = "29a5eee";

/**
 * 要提取的文件。
 *
 * `WorldScene` 是主体，但它 import 了一串东西 ——
 * 少了任何一个都加载不起来。
 */
const LEGACY_FILES: Array<{ name: string; sourcePath: string }> = [
  { name: "WorldScene.ts", sourcePath: "client/src/scenes/WorldScene.ts" },
  { name: "CharacterSprite.ts", sourcePath: "client/src/objects/CharacterSprite.ts" },
  { name: "game-config.ts", sourcePath: "client/src/config/game-config.ts" },
  { name: "MapManager.ts", sourcePath: "client/src/systems/MapManager.ts" },
  { name: "PathfindingManager.ts", sourcePath: "client/src/systems/PathfindingManager.ts" },
  { name: "CharacterMovement.ts", sourcePath: "client/src/systems/CharacterMovement.ts" },
  { name: "PlaybackController.ts", sourcePath: "client/src/systems/PlaybackController.ts" },
  { name: "CameraController.ts", sourcePath: "client/src/systems/CameraController.ts" },
  { name: "EventBus.ts", sourcePath: "client/src/EventBus.ts" },
  { name: "api-types.ts", sourcePath: "client/src/types/api.ts" },
];

/**
 * import 路径要改写。
 *
 * 提取到同一个目录后，原来跨目录的相对路径（`../config/game-config`）
 * 都断了 —— 改成同目录的 `./xxx`。
 *
 * **`phaser` 改成测试替身** —— 真 Phaser 在 node 里跑不起来。
 */
const IMPORT_REWRITES: Array<[RegExp, string]> = [
  [/from ["']phaser["']/g, 'from "./phaser-stub.js"'],
  [/from ["']@own-world\/client-core["']/g, 'from "../../index.js"'],
  [/from ["']\.\.\/config\/game-config["']/g, 'from "./game-config.js"'],
  [/from ["']\.\.\/objects\/CharacterSprite["']/g, 'from "./CharacterSprite.js"'],
  [/from ["']\.\.\/systems\/MapManager["']/g, 'from "./MapManager.js"'],
  [/from ["']\.\.\/systems\/PathfindingManager["']/g, 'from "./PathfindingManager.js"'],
  [/from ["']\.\.\/systems\/CharacterMovement["']/g, 'from "./CharacterMovement.js"'],
  [/from ["']\.\.\/systems\/PlaybackController["']/g, 'from "./PlaybackController.js"'],
  [/from ["']\.\.\/systems\/CameraController["']/g, 'from "./CameraController.js"'],
  [/from ["']\.\.\/EventBus["']/g, 'from "./EventBus.js"'],
  [/from ["']\.\.\/types\/api["']/g, 'from "./api-types.js"'],
  [/from ["']\.\.\/ui\/services\/api-client["']/g, 'from "./api-client.js"'],
  [/from ["']\.\/MapManager["']/g, 'from "./MapManager.js"'],
  [/from ["']\.\/PathfindingManager["']/g, 'from "./PathfindingManager.js"'],
];

/**
 * 地图数据层的门面 —— 指向**现在的** client-core。
 *
 * 改造前的 `client/src/systems/MapManager.ts` 已经是
 * `@own-world/client-core` 的门面了（阶段 5 搬完的），
 * 所以这两个文件**不用从 git 提取** —— 直接指向现在的实现。
 *
 * 这不是「用新实现给自己当基准」：
 * 阶段 5 的 A/B 对比（`ab-comparison.test.ts`）已经证明
 * 「现在的 client-core」跟「阶段 5 之前的 client MapManager」逐点相等。
 *
 * 8.1 关心的是**渲染层**的位置逻辑，不是地图数据层。
 */
const CURRENT_CLIENT_CORE_FACADES: Record<string, string> = {
  "MapManager.ts": `export { MapManager } from "../../map-model.js";
export type {
  InteractiveObject,
  LocationRect,
  MainAreaPointNode,
} from "../../map-model.js";
`,
  "PathfindingManager.ts": `export { PathfindingManager } from "../../pathfinding.js";
export type { GridPoint, StepAxis } from "../../types.js";
`,
};

/**
 * `api-client` —— 替换成一个不联网的桩。
 *
 * `WorldScene` 会调 `apiClient.getWorldInfo()` / `getCharacters()`。
 * A/B 测试里我们**不**让老代码走网络（那不是被检验的部分），
 * 角色和世界信息由测试自己喂进去。
 */
const API_CLIENT_STUB = `
/**
 * A/B 测试专用的 api-client 桩 —— 不联网。
 *
 * 测试通过 \`__setApiStubData()\` 喂数据。
 */
export interface StubWorldInfo {
  centerLocationId?: string;
  mainAreaPoints?: unknown[];
}
export interface StubCharacter {
  id: string;
  name: string;
  location: string;
  mainAreaPointId?: string | null;
}

let worldInfo: StubWorldInfo = {};
let characters: StubCharacter[] = [];

export function __setApiStubData(next: {
  worldInfo?: StubWorldInfo;
  characters?: StubCharacter[];
}): void {
  if (next.worldInfo) worldInfo = next.worldInfo;
  if (next.characters) characters = next.characters;
}

export const apiClient = {
  async getWorldInfo() { return worldInfo as any; },
  async getCharacters() { return characters as any; },
  async getWorldTime() { return { day: 1, hour: 8, minute: 0 } as any; },
  async patchCharacterRuntimeState() { return {} as any; },
  async getTimelineEvents() { return { frames: [] } as any; },
};
`;

/**
 * 提取到哪 —— 仓库内的临时目录。
 *
 * **必须在项目内，不能放 node_modules** ——
 * tsx 不 transform `node_modules` 里的文件（那是依赖，不是源码）。
 */
const CACHE_DIR = path.join(HERE, ".tmp-legacy-scene-baseline");

/** 基准加载结果。 */
export type LegacySceneBaseline =
  | {
      ok: true;
      /** 改造前的 `WorldScene` 类。 */
      WorldScene: new () => any;
      /** 改造前的 `CharacterSprite` 类。 */
      CharacterSprite: new (...args: any[]) => any;
      /** 改造前的 `createCharacterDisplayMetrics`。 */
      createCharacterDisplayMetrics: (w: number, h: number) => any;
      /** 改造前的 `actionToEmoji`。 */
      actionToEmoji: (action: string | null) => string;
      /** 改造前的 `getCharacterColor`。 */
      getCharacterColor: (index: number) => number;
      /**
       * 改造前的 `MapManager`（门面，指向现在的 client-core）。
       *
       * 阶段 5 搬完之后，改造前的 `client/src/systems/MapManager.ts`
       * 就只是一行 re-export —— 所以它跟新实现是**同一份**。
       *
       * 这不是「用新实现给自己当基准」：
       * 阶段 5 的 A/B 对比已经证明它跟阶段 5 之前的 client MapManager 逐点相等。
       * 8.1 关心的是**渲染层**，不是地图数据层。
       */
      MapManager: new () => any;
      /**
       * 设置**替身**的文字测量方式。
       *
       * ## 为什么必须暴露它
       *
       * A/B 比的是「两边量出来的尺寸」——
       * 如果旧实现用一套测量、新实现用另一套，
       * 差异会被误读成「位置逻辑不一样」。
       *
       * 桩件自带一个默认测量（每字 8px、高 16），
       * 测试必须**把它指向 builder 用的同一个测量函数**，
       * 两边量出来才可比。
       */
      setStubTextMeasurer: (measurer: (text: string, font?: string) => {
        width: number;
        height: number;
      }) => void;
    }
  | { ok: false; reason: string };

let cached: LegacySceneBaseline | null = null;

/**
 * 从 git 提取基准文件。
 */
function extractFromGit(): { dir: string } | { error: string } {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  } catch (err) {
    return { error: `建不了缓存目录：${(err as Error).message}` };
  }

  for (const file of LEGACY_FILES) {
    const target = path.join(CACHE_DIR, file.name);
    if (fs.existsSync(target)) continue;

    // 地图数据层的门面 —— 指向现在的 client-core（见上面的说明）。
    const facade = CURRENT_CLIENT_CORE_FACADES[file.name];
    if (facade) {
      fs.writeFileSync(target, facade, "utf-8");
      continue;
    }

    let code: string;
    try {
      code = execFileSync("git", ["show", `${LEGACY_SCENE_COMMIT}:${file.sourcePath}`], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr ?? "";
      return {
        error:
          `git show ${LEGACY_SCENE_COMMIT}:${file.sourcePath} 失败` +
          (stderr ? `：${stderr.trim()}` : ""),
      };
    }

    for (const [pattern, replacement] of IMPORT_REWRITES) {
      code = code.replace(pattern, replacement);
    }
    fs.writeFileSync(target, code, "utf-8");
  }

  // api-client 的桩
  const apiClientPath = path.join(CACHE_DIR, "api-client.ts");
  if (!fs.existsSync(apiClientPath)) {
    fs.writeFileSync(apiClientPath, API_CLIENT_STUB, "utf-8");
  }

  // 测试替身（Phaser 的替身 + stub 导出）
  const stubSource = fs.readFileSync(path.join(HERE, "phaser-stub.ts"), "utf-8");
  fs.writeFileSync(path.join(CACHE_DIR, "phaser-stub.ts"), stubSource, "utf-8");

  return { dir: CACHE_DIR };
}

/**
 * 加载基准实现。
 *
 * **不抛错** —— 拿不到就返回 `{ ok: false, reason }`。
 */
export async function loadLegacySceneBaseline(): Promise<LegacySceneBaseline> {
  if (cached) return cached;

  const extracted = extractFromGit();
  if ("error" in extracted) {
    cached = { ok: false, reason: extracted.error };
    return cached;
  }

  try {
    const { tsImport } = await import("tsx/esm/api");
    const sceneMod = await tsImport(
      pathToFileURL(path.join(extracted.dir, "WorldScene.ts")).href,
      import.meta.url,
    );
    const spriteMod = await tsImport(
      pathToFileURL(path.join(extracted.dir, "CharacterSprite.ts")).href,
      import.meta.url,
    );
    const configMod = await tsImport(
      pathToFileURL(path.join(extracted.dir, "game-config.ts")).href,
      import.meta.url,
    );
    const stubMod = await tsImport(
      pathToFileURL(path.join(extracted.dir, "phaser-stub.ts")).href,
      import.meta.url,
    );
    const mapMod = await tsImport(
      pathToFileURL(path.join(extracted.dir, "MapManager.ts")).href,
      import.meta.url,
    );
    cached = {
      ok: true,
      WorldScene: sceneMod.WorldScene,
      CharacterSprite: spriteMod.CharacterSprite,
      createCharacterDisplayMetrics: configMod.createCharacterDisplayMetrics,
      actionToEmoji: configMod.actionToEmoji,
      getCharacterColor: configMod.getCharacterColor,
      setStubTextMeasurer: stubMod.setStubTextMeasurer,
      MapManager: mapMod.MapManager,
    };
  } catch (err) {
    cached = { ok: false, reason: `加载基准失败：${(err as Error).message}` };
  }
  return cached;
}
