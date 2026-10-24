/**
 * 插件契约 —— 世界生成流程的扩展点。
 *
 * 目标：**加功能不改核心代码**。
 *
 * 一个插件就是一个对象，带一个 `name`，以及若干个钩子。
 * 钩子按阶段分组，一个插件实现哪个就参与哪个阶段 —— 没实现的
 * 阶段直接跳过，不用写空函数。
 *
 * ```js
 * export default {
 *   name: "my-plugin",
 *   design(worldDesign, ctx) {
 *     return { ...worldDesign, myField: 1 };   // 返回新对象
 *   },
 * };
 * ```
 *
 * ## 为什么参数是只读的
 *
 * 钩子收到的参数**不要就地改** —— 要改就返回新对象。
 *
 * 原因：多个插件按固定顺序跑，如果都能就地改同一个对象，
 * 那「谁先跑谁后跑」就会影响结果，调试时没法复现。
 * 返回新对象的话，顺序是确定的，链式传递也很清楚。
 *
 * ## 为什么不放 packages/core
 *
 * core 是 TypeScript，且阶段 1 定了「core 不碰文件系统」的边界。
 * 而插件加载**必须**读文件系统（扫 `plugins/` 目录）。
 * 所以契约和加载器都放在 orchestrator 侧 —— 它本来就是纯 .mjs。
 */

/**
 * 支持的钩子名。
 *
 * - `design`           —— 世界设计完成后，可以改设计
 * - `generate`         —— 素材生成阶段，可以往 worldDir 里写东西
 * - `extendWorldConfig`—— 配置生成阶段，可以增补世界配置
 *
 * 为什么**没有** `simulate`：orchestrator 生成完世界就退出了，
 * 跟 core 的模拟引擎是两套生命周期，插不进 simulate 钩子。
 * 模拟期的扩展点应该放在 core 或 server 那边。
 */
export const PLUGIN_HOOKS = ["design", "generate", "extendWorldConfig"];

/**
 * 插件运行时的上下文。
 *
 * 这些是**只读**的元信息 —— 插件可以读，但不能改。
 */
export const PLUGIN_CONTEXT = {
  /**
   * 世界输出目录 —— 插件要写文件就往这儿写。
   * 由 orchestrator 创建，插件**不要**自己 mkdir 世界的其它部分。
   */
  worldDir: "",

  /** 用户的原始描述（一句话建世界的那句）。 */
  userPrompt: "",

  /** 世界 ID。 */
  worldId: "",

  /** 日志前缀 —— 插件自己打日志时带上，便于区分来源。 */
  logPrefix: "[Plugin]",
};

/**
 * 校验一个插件对象是否合法。
 *
 * 校验失败**抛错**，不静默跳过 —— 插件写错了要让人知道，
 * 静默跳过的话会变成「我明明写了插件为什么没生效」。
 *
 * @param {unknown} plugin 待校验的对象
 * @returns {object} 校验通过的插件（原样返回，方便链式调用）
 */
export function validatePlugin(plugin) {
  if (!plugin || typeof plugin !== "object") {
    throw new Error("插件必须是对象");
  }

  if (typeof plugin.name !== "string" || !plugin.name.trim()) {
    throw new Error("插件必须有非空的 name 字段");
  }

  const implemented = PLUGIN_HOOKS.filter((hook) => typeof plugin[hook] === "function");

  if (implemented.length === 0) {
    throw new Error(
      `插件 "${plugin.name}" 没有实现任何钩子 —— 至少要实现一个：${PLUGIN_HOOKS.join(" / ")}`,
    );
  }

  for (const hook of PLUGIN_HOOKS) {
    if (plugin[hook] !== undefined && typeof plugin[hook] !== "function") {
      throw new Error(`插件 "${plugin.name}" 的 ${hook} 钩子必须是函数`);
    }
  }

  if (plugin.critical !== undefined && typeof plugin.critical !== "boolean") {
    throw new Error(`插件 "${plugin.name}" 的 critical 字段必须是布尔值`);
  }

  return plugin;
}

/**
 * 插件实现了哪些钩子。
 *
 * @param {object} plugin
 * @returns {string[]} 钩子名数组
 */
export function implementedHooks(plugin) {
  return PLUGIN_HOOKS.filter((hook) => typeof plugin?.[hook] === "function");
}
