/**
 * 插件加载器 —— 从 `plugins/` 目录把插件读进来。
 *
 * ## 为什么 `.ts` 插件要用 tsx
 *
 * 插件用 TypeScript 写更自然（有类型提示），但 orchestrator 是用**纯 node**
 * 启动的（server 用 `spawn(process.execPath, ...)` 拉它），
 * 没有 `--import tsx` 之类的 flag。
 *
 * 试过的三条路：
 *
 * | 方案 | 纯 node 下能工作？ |
 * |---|---|
 * | `node --experimental-strip-types` | ❌ 要 flag，且**不支持 enum**（`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`） |
 * | spawn 子进程跑 tsx | ❌ 插件拿不到主进程状态，没法参与管线 |
 * | **`tsx/esm/api` 的 `tsImport()`** | ✅ |
 *
 * 所以用 `tsx/esm/api`。这意味着 `tsx` 必须是**运行时依赖**，
 * 不能只放在 devDependencies 里。
 *
 * ## 降级行为
 *
 * 如果 `tsx` 装不上（比如生产环境漏装），**只加载 `.mjs` 插件**，
 * 并给出明确警告 —— 不崩掉整个世界生成。
 * TS 插件的作者会看到「你的插件没被加载」。
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, extname, basename, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validatePlugin } from "./plugin-contract.mjs";

/**
 * 加载 TS 用的 `tsImport`。
 *
 * 用动态 import 而不是静态 import —— 因为 `tsx` 可能是可选的
 * （生产环境没装），静态 import 会让整个模块加载失败。
 */
let tsImport = null;
let tsxLoadError = null;

async function ensureTsx() {
  if (tsImport) return tsImport;
  if (tsxLoadError) return null;
  try {
    const mod = await import("tsx/esm/api");
    tsImport = mod.tsImport;
    return tsImport;
  } catch (err) {
    tsxLoadError = err;
    return null;
  }
}

/** 是不是 TS 文件。 */
function isTypeScript(filePath) {
  return [".ts", ".mts", ".cts"].includes(extname(filePath));
}

/**
 * 从一个文件里取出插件对象。
 *
 * 优先级：`default` 导出 → 第一个具名导出。
 * 这样插件作者两种写法都能用：
 *
 * ```ts
 * export default { name: "x", ... }        // 默认导出
 * export const plugin = { name: "x", ... }   // 具名导出
 * ```
 */
function extractPlugin(moduleExports, filePath) {
  if (moduleExports?.default && typeof moduleExports.default === "object") {
    return moduleExports.default;
  }

  for (const [key, value] of Object.entries(moduleExports)) {
    if (key === "default") continue;
    if (value && typeof value === "object" && typeof value.name === "string") {
      return value;
    }
  }

  throw new Error(
    `${filePath} 里找不到插件对象 —— 要么用 export default {...}，` +
      `要么导出一个带 name 的具名对象`,
  );
}

/**
 * 加载一个插件文件。
 *
 * @param {string} filePath 插件文件绝对路径
 * @returns {Promise<object>} 校验通过的插件
 */
export async function loadPluginFile(filePath) {
  let moduleExports;

  if (isTypeScript(filePath)) {
    const load = await ensureTsx();
    if (!load) {
      throw new Error(
        `加载 TS 插件 ${basename(filePath)} 失败：tsx 装不上。` +
          `（tsx 必须是运行时依赖 —— 它在根 package.json 的 dependencies 里）`,
      );
    }
    // tsImport 的第一个参数要传 **import.meta.url**（父模块的 URL），
    // 第二个参数传要加载的模块的 URL —— 不是文件系统路径。
    // 传 Windows 绝对路径会报 "Received protocol 'e:'"。
    moduleExports = await load(pathToFileURL(filePath).href, import.meta.url);
  } else {
    moduleExports = await import(pathToFileURL(filePath).href);
  }

  const plugin = extractPlugin(moduleExports, filePath);
  return validatePlugin(plugin);
}

/**
 * 扫描目录，找出所有候选插件文件。
 *
 * 只看一层 —— 插件放子目录里会让「哪个被加载了」变得难猜。
 *
 * @param {string} dir 目录绝对路径
 * @returns {string[]} 插件文件绝对路径
 */
export function findPluginFiles(dir) {
  if (!existsSync(dir)) return [];

  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) continue;

    const ext = extname(entry.name);
    if (ext !== ".mjs" && ext !== ".js" && ext !== ".ts" && ext !== ".mts") continue;

    const full = join(dir, entry.name);
    if (statSync(full).isFile()) out.push(full);
  }
  return out;
}

/**
 * 加载一个目录下的所有插件。
 *
 * **单个插件加载失败不抛错** —— 记录下来继续。
 * 一个坏插件不该让整个世界生成停下来。
 *
 * @param {string} dir 插件目录绝对路径
 * @returns {Promise<{plugins: object[], errors: Array<{file: string, error: string}>}>}
 */
export async function loadPluginsFromDir(dir) {
  const plugins = [];
  const errors = [];

  for (const file of findPluginFiles(dir)) {
    try {
      plugins.push(await loadPluginFile(file));
    } catch (err) {
      errors.push({ file, error: err?.message ?? String(err) });
    }
  }

  return { plugins, errors };
}

/**
 * 插件目录 —— 仓库根的 `plugins/`。
 *
 * 跟 `prompts/`、`config/` 平级 —— 那两个也是「根目录下的约定位置」。
 *
 * 用 `fileURLToPath` 而不是 `url.pathname` —— 后者在 Windows 上
 * 会把盘符变成 `/E:/...`，拼出来的路径不对。
 */
export const PLUGINS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
  "plugins",
);
