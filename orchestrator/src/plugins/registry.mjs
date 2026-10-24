/**
 * 插件注册表 —— 决定「哪些插件、按什么顺序、在哪个阶段跑」。
 *
 * ## 顺序由配置决定，不靠文件系统枚举顺序
 *
 * `readdirSync` 的返回顺序**不保证**（不同平台、不同文件系统都不一样）。
 * 如果插件顺序靠枚举顺序决定，那「同样两个插件，换台机器跑结果就不一样」——
 * 这种 bug 极难查。所以顺序一律读 `config/plugins.json`。
 *
 * ## 错误隔离
 *
 * 一个插件挂了**不能拖垮整个世界生成** —— 除非它声明了 `critical: true`。
 *
 * 默认行为：记录错误、跳过这个插件、继续跑后面的。
 * 理由：插件是可选的扩展，主流程不该因为第三方代码出错就整个失败。
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN_HOOKS, implementedHooks } from "./plugin-contract.mjs";
import { loadPluginsFromDir, PLUGINS_DIR } from "./loader.mjs";

/** 插件配置 —— 仓库根的 `config/plugins.json`。 */
export const PLUGIN_CONFIG_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../config/plugins.json",
);

/**
 * 读插件配置。
 *
 * 配置文件不存在 → 返回空列表（不报错）。
 * 「没有配置」是合法状态 —— 用户可能还没用插件。
 */
export function loadPluginConfig(configPath = PLUGIN_CONFIG_PATH) {
  if (!existsSync(configPath)) {
    return { plugins: [] };
  }
  const raw = readFileSync(configPath, "utf-8");
  try {
    const parsed = JSON.parse(raw);
    return {
      plugins: Array.isArray(parsed?.plugins) ? parsed.plugins : [],
    };
  } catch (err) {
    throw new Error(`插件配置 ${configPath} 解析失败：${err.message}`);
  }
}

/**
 * 组装出最终要跑的插件列表。
 *
 * 流程：
 * 1. 扫 `plugins/` 目录 —— **找到的插件文件全都算**（这是「加个文件就生效」的关键）
 * 2. 读 `config/plugins.json` —— 只用来**调顺序**和**关掉某个插件**
 *
 * 配置项：
 * ```json
 * { "plugins": [
 *     { "name": "economy" },              // 排第一
 *     { "name": "old-thing", "enabled": false }   // 关掉
 * ] }
 * ```
 *
 * 配置文件里**没提到**的插件照样会跑，只是排在后面。
 * 所以「加一个插件文件」不需要改任何配置 —— 放下就生效。
 *
 * 顺序：配置里列的按配置顺序在前，其余的按**文件名排序**在后。
 * 不用 `readdirSync` 的返回顺序 —— 那个**不保证**，
 * 换台机器结果就不一样，这种 bug 极难查。
 *
 * @returns {Promise<{plugins: object[], errors: Array<{source: string, error: string}>}>}
 */
export async function buildPluginRegistry(options = {}) {
  const pluginsDir = options.pluginsDir ?? PLUGINS_DIR;
  const configPath = options.configPath ?? PLUGIN_CONFIG_PATH;

  const config = loadPluginConfig(configPath);
  const errors = [];
  const loaded = new Map();
  const usedNames = new Set();

  // 配置文件里的顺序和开关
  const order = [];
  const disabled = new Set();
  for (const entry of config.plugins) {
    const name = entry?.name;
    if (!name || typeof name !== "string") {
      errors.push({ source: configPath, error: "插件配置项缺少 name" });
      continue;
    }
    if (entry.enabled === false) {
      disabled.add(name);
      continue;
    }
    order.push(name);
  }

  // 1. 扫目录 —— 目录里的插件文件全都算
  const { plugins: candidates, errors: loadErrors } = await loadPluginsFromDir(pluginsDir);
  errors.push(...loadErrors);

  for (const plugin of candidates) {
    if (usedNames.has(plugin.name)) {
      errors.push({
        source: plugin.name,
        error: `插件名 "${plugin.name}" 重复了 —— 后一个被忽略`,
      });
      continue;
    }
    usedNames.add(plugin.name);
    loaded.set(plugin.name, plugin);
  }

  // 2. 排序 —— 配置里列的在前，其余按文件名排
  const sorted = [];
  for (const name of order) {
    const plugin = loaded.get(name);
    if (!plugin) {
      if (!disabled.has(name)) {
        errors.push({
          source: name,
          error: `配置里列了插件 "${name}"，但在 ${pluginsDir} 里没找到`,
        });
      }
      continue;
    }
    sorted.push(plugin);
    loaded.delete(name);
  }
  for (const plugin of [...loaded.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    sorted.push(plugin);
  }

  // 3. 关掉的插件
  const enabled = sorted.filter((p) => {
    if (disabled.has(p.name)) {
      console.log(`[Plugin] "${p.name}" 已在配置里关掉，跳过`);
      return false;
    }
    return true;
  });

  return { plugins: enabled, errors };
}

/**
 * 跑一个阶段的插件。
 *
 * 每个插件收到的值是**上一步的返回值** —— 链式传递。
 * 插件返回 undefined / null 表示「我不改」，值原样传给下一个。
 *
 * @param {object[]} plugins 插件列表
 * @param {string} hook 钩子名
 * @param {*} value 初始值
 * @param {object} ctx 运行时上下文
 * @returns {Promise<{value: *, executed: string[], errors: Array<{plugin: string, error: string}>}>}
 */
export async function runHook(plugins, hook, value, ctx) {
  const executed = [];
  const errors = [];
  let current = value;

  for (const plugin of plugins) {
    if (typeof plugin[hook] !== "function") continue;

    const label = plugin.name;
    try {
      const result = await plugin[hook](current, ctx);
      if (result !== undefined && result !== null) {
        current = result;
      }
      executed.push(label);
    } catch (err) {
      const message = err?.message ?? String(err);
      errors.push({ plugin: label, error: message });

      if (plugin.critical === true) {
        throw new Error(
          `关键插件 "${label}" 在 ${hook} 阶段失败，已中止世界生成：${message}`,
        );
      }
      console.warn(`[Plugin] "${label}" 在 ${hook} 阶段失败，已跳过：${message}`);
    }
  }

  return { value: current, executed, errors };
}

/**
 * 加载所有插件并跑完三个阶段。
 *
 * 这是 orchestrator 侧对外的单一入口。
 *
 * @param {object} options
 * @param {string} options.worldDir 世界输出目录
 * @param {string} options.userPrompt 用户原始描述
 * @param {string} options.worldId 世界 ID
 * @returns {Promise<{plugins: object[], errors: Array<{source: string, error: string}>}>}
 */
export async function loadPlugins(options = {}) {
  const { plugins, errors } = await buildPluginRegistry(options);

  if (errors.length > 0) {
    for (const e of errors) {
      console.warn(`[Plugin] 加载失败（${e.source}）：${e.error}`);
    }
  }

  if (plugins.length > 0) {
    const summary = plugins
      .map((p) => `${p.name}[${implementedHooks(p).join("/") || "无钩子"}]`)
      .join(", ");
    console.log(`[Plugin] 已加载 ${plugins.length} 个插件：${summary}`);
  } else {
    console.log("[Plugin] 没有加载任何插件");
  }

  return { plugins, errors };
}

export { PLUGIN_HOOKS, implementedHooks };
