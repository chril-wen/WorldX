/**
 * 改造前的基准 —— 运行时从 **git 历史**里取。
 *
 * ## 为什么不是把基准代码存在仓库里
 *
 * 阶段 5 最初的做法是把改造前的 `MapManager` / `PathfindingManager`
 * 逐字副本放进 `.legacy-baseline/`，测试 import 它。
 *
 * 那个做法有个说不出口的坏处：**仓库里多一份重复代码**。
 * 以后改 `MapManager` 的人得记得「基准也要改」——
 * 忘了，基准就跟产品代码分家，A/B 变成自证清白。
 *
 * 改成从 git 提取就没有这个问题：
 * 基准**永远**是那个 commit 里的字面实现，
 * 没人能「顺手改一下基准」—— 它不在工作区里。
 *
 * ## 为什么用 git 而不是打包一份 tarball
 *
 * tarball 也解决不了「基准被顺手改」的问题（它就在仓库里）。
 * git 有个更实际的好处：**基准和它的说明写在同一个地方** ——
 * 这个文件本身就是「改造前长什么样」的文档。
 *
 * ## 提取不出来怎么办
 *
 * **跳过，不红。**
 *
 * 基准是**辅助验证**，不是产品逻辑：
 * 它的作用是「证明新实现跟改造前逐点一致」。
 * 拿不到基准时，正确的反应是「这次没做这项验证」，
 * 而不是「测试失败」——
 * 后者会让人以为产品坏了。
 *
 * 拿不到的三种情况：
 *
 * 1. **浅克隆**（CI 默认 depth=1）—— 拿不到历史 commit
 * 2. **导出 tarball**（`git archive` / GitHub 的 zip 下载）—— 没有 .git
 * 3. **仓库刚初始化、还没提交** —— 没有历史
 *
 * CI 里通过 `fetch-depth: 0` 解决第 1 种。
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 仓库根 —— 从这个文件往上三层（src → client-core → packages → 根）。 */
const REPO_ROOT = path.resolve(HERE, "../../..");

/**
 * 改造前的 commit。
 *
 * 选它的理由：它是「地图数据层搬进 packages/client-core」那次提交的**父提交** ——
 * 也就是搬运**之前**的最后状态。
 *
 * 换句话说：这个 commit 里的 `MapManager` 就是「阶段 5 之前」的版本。
 */
export const LEGACY_COMMIT = "a7aa8f0";

/**
 * 要提取的文件 —— 基准实现 + 它的依赖。
 *
 * `MapManager` import 了 `game-config` 和 `api-types`，
 * `PathfindingManager` import 了 `MapManager`。
 * 少了任何一个都加载不起来。
 */
const LEGACY_FILES: Array<{ name: string; sourcePath: string }> = [
  { name: "MapManager.ts", sourcePath: "client/src/systems/MapManager.ts" },
  { name: "PathfindingManager.ts", sourcePath: "client/src/systems/PathfindingManager.ts" },
  { name: "game-config.ts", sourcePath: "client/src/config/game-config.ts" },
  { name: "api-types.ts", sourcePath: "client/src/types/api.ts" },
];

/**
 * import 路径要改写。
 *
 * 改造前这些文件在 `client/src/systems/` 和 `client/src/config/`、
 * `client/src/types/` 下，互相 import 时用 `../config/xxx`、`../types/xxx`。
 *
 * 提取到同一个临时目录后，这些相对路径就断了 ——
 * 得改成同目录的 `./xxx`。
 */
const IMPORT_REWRITES: Array<[RegExp, string]> = [
  [/"(\.\.\/config\/game-config)"/g, '"./game-config"'],
  [/"(\.\.\/types\/api)"/g, '"./api-types"'],
];

/**
 * 提取到哪 —— 仓库内的临时目录。
 *
 * **必须在项目内，不能放 node_modules** ——
 * tsx 不 transform `node_modules` 里的文件（那是依赖，不是源码）。
 * 放在 node_modules 下的话，加载基准会报「Unexpected token '{'」。
 *
 * 目录名跟仓库里已有的 `.tmp-plugin-tests` 一个惯例：
 * 临时的、跑完可以删的、gitignore 掉的。
 */
const CACHE_DIR = path.join(HERE, ".tmp-legacy-baseline");

/**
 * 基准加载结果。
 *
 * `ok: false` 时 `reason` 说明为什么拿不到 —— 测试报告里要能看懂。
 */
export type LegacyBaseline =
  | {
      ok: true;
      MapManager: new () => any;
      PathfindingManager: new (map: any) => any;
    }
  | { ok: false; reason: string };

let cached: LegacyBaseline | null = null;

/**
 * 从 git 提取基准文件。
 *
 * @returns 提取到���目录，失败时返回 null
 */
function extractFromGit(): { dir: string } | { error: string } {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  } catch (err) {
    return { error: `建不了缓存目录：${(err as Error).message}` };
  }

  for (const file of LEGACY_FILES) {
    const target = path.join(CACHE_DIR, file.name);
    // 已经提取过就跳过 —— git show 不便宜，测试里会反复调。
    if (fs.existsSync(target)) continue;

    let code: string;
    try {
      code = execFileSync("git", ["show", `${LEGACY_COMMIT}:${file.sourcePath}`], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr ?? "";
      return {
        error:
          `git show ${LEGACY_COMMIT}:${file.sourcePath} 失败` +
          (stderr ? `：${stderr.trim()}` : ""),
      };
    }

    for (const [pattern, replacement] of IMPORT_REWRITES) {
      code = code.replace(pattern, replacement);
    }
    fs.writeFileSync(target, code, "utf-8");
  }

  return { dir: CACHE_DIR };
}

/**
 * 加载基准实现。
 *
 * **不抛错** —— 拿不到就返回 `{ ok: false, reason }`，
 * 调用方（测试、冒烟脚本）自己决定拿不到时怎么办。
 */
export async function loadLegacyBaseline(): Promise<LegacyBaseline> {
  if (cached) return cached;

  const extracted = extractFromGit();
  if ("error" in extracted) {
    cached = { ok: false, reason: extracted.error };
    return cached;
  }

  try {
    // **必须用 tsImport，不能用普通 import()** ——
    // 基准文件是 `.ts`，普通 import() 不走 tsx 的 transform，
    // 在纯 node 下会报「Unexpected token '{'」。
    //
    // vitest 里普通 import() 恰好能work（vitest 自带 transform），
    // 但 `scripts/client-core-smoke.mjs` 是纯 node 跑的 ——
    // 两边行为必须一致，所以统一走 tsImport。
    const { tsImport } = await import("tsx/esm/api");
    const mapMod = await tsImport(
      pathToFileURL(path.join(extracted.dir, "MapManager.ts")).href,
      import.meta.url,
    );
    const pathMod = await tsImport(
      pathToFileURL(path.join(extracted.dir, "PathfindingManager.ts")).href,
      import.meta.url,
    );
    cached = {
      ok: true,
      MapManager: mapMod.MapManager,
      PathfindingManager: pathMod.PathfindingManager,
    };
  } catch (err) {
    cached = { ok: false, reason: `加载基准失败：${(err as Error).message}` };
  }
  return cached;
}
