/**
 * `orchestrator/src/plugins/plugin-contract.mjs` 的类型声明。
 *
 * 那个文件是纯 `.mjs`（跟 orchestrator 其它文件一致），
 * 但 server / core 的 TypeScript 可能要引用这个契约 —— 所以补一份手写声明。
 */

/** 插件支持的钩子名。 */
export type PluginHook = "design" | "generate" | "extendWorldConfig";

/** 插件运行时上下文 —— 只读。 */
export interface PluginContext {
  /** 世界输出目录 —— 插件要写文件就往这儿写。 */
  worldDir: string;
  /** 用户的原始描述。 */
  userPrompt: string;
  /** 世界 ID。 */
  worldId: string;
  /** 日志前缀。 */
  logPrefix: string;
}

/** 世界设计对象 —— 形状见 `normalizeWorldDesign` 的返回值。 */
export interface WorldDesign {
  worldName: string;
  worldDescription: string;
  mapDescription: string;
  characters: unknown[];
  regions: unknown[];
  interactiveElements: unknown[];
  worldActions: unknown[];
  sceneType: string;
  [key: string]: unknown;
}

/** 世界配置 —— 形状见 `generateConfigs` 的返回值。 */
export interface WorldConfigBundle {
  worldConfig: Record<string, unknown>;
  characterConfigs: unknown[];
  sceneConfig: Record<string, unknown>;
}

/** 一个世界插件。 */
export interface WorldPlugin {
  /** 插件名 —— 要唯一，出错时用它定位。 */
  name: string;

  /**
   * 设计阶段之后调用。
   *
   * @param design 世界设计（只读）
   * @param ctx 运行时上下文
   * @returns 新的设计对象，或 undefined 表示不改
   */
  design?(design: WorldDesign, ctx: PluginContext): WorldDesign | void | Promise<WorldDesign | void>;

  /**
   * 素材生成阶段调用 —— 地图和角色都生成完之后。
   *
   * @param design 世界设计（只读）
   * @param ctx 运行时上下文
   */
  generate?(
    design: WorldDesign,
    ctx: PluginContext,
  ): void | Promise<void>;

  /**
   * 配置生成阶段调用 —— 能增补世界配置。
   *
   * @param configs { worldConfig, characterConfigs, sceneConfig }
   * @param ctx 运行时上下文
   * @returns 增补后的配置，或 undefined 表示不改
   */
  extendWorldConfig?(
    configs: WorldConfigBundle,
    ctx: PluginContext,
  ): WorldConfigBundle | void | Promise<WorldConfigBundle | void>;

  /**
   * 关键插件 —— 失败时中止整个世界生成，而不是跳过。
   *
   * 默认 false：普通插件出错只记录并跳过，不拖垮主流程。
   */
  critical?: boolean;
}

export declare const PLUGIN_HOOKS: PluginHook[];
export declare const PLUGIN_CONTEXT: {
  worldDir: string;
  userPrompt: string;
  worldId: string;
  logPrefix: string;
};

export declare function validatePlugin(plugin: unknown): WorldPlugin;
export declare function implementedHooks(plugin: WorldPlugin): PluginHook[];
