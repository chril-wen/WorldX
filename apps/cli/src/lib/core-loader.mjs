/**
 * 加载 core 的 TypeScript 模块。
 *
 * ## 为什么用 tsx
 *
 * core 是 TypeScript。CLI 是纯 `.mjs`（不构建、不打包，直接 `node` 跑）。
 *
 * 两个选择：
 *
 * 1. 走 `dist/` —— 要先 `npm run build`，改了 core 还得重新 build
 * 2. 走 `tsx` —— 直接吃源码，跟 vitest、跟 `scripts/rules.mjs` 一样
 *
 * 选 2。理由是**改了 core 立刻能验**，不用等 build。
 * 这跟 `scripts/rules.mjs` 的选择一致（它的注释里也是这么说的）。
 *
 * ## 为什么只加载需要的
 *
 * core 有一堆模块（world-manager 读文件、character-manager 碰数据库）。
 * CLI 只用**纯函数**那几个 —— 所以按需加载具体文件，
 * 不加载包根（包根会把 world-manager 拖进来）。
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import { PROJECT_DIR } from "./world-paths.mjs";

/**
 * 加载 core 里的一个模块。
 *
 * @param {string} relativePath 相对 `packages/core/src/` 的路径
 *   比如 `simulation/event-format.js`
 * @returns {Promise<any>} 模块的导出
 */
export async function loadCoreModule(relativePath) {
  const { tsImport } = await import("tsx/esm/api");
  const entry = path.join(PROJECT_DIR, "packages", "core", "src", relativePath);
  return tsImport(pathToFileURL(entry).href, import.meta.url);
}

/**
 * 加载 core 的事件格式化工具。
 *
 * @returns {Promise<typeof import("../../../../packages/core/src/simulation/event-format.ts")>}
 */
export async function loadEventFormat() {
  return loadCoreModule("simulation/event-format.js");
}
