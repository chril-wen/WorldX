/**
 * 命令表。
 *
 * ## 为什么单独一个文件
 *
 * `index.mjs`（入口）要 import 这个表来分发，
 * `help.mjs`（打印帮助）也要 import 这个表来列命令。
 *
 * 如果表放在 `index.mjs` 里，`help.mjs` import 它就形成**循环依赖** ——
 * `index.mjs` → `help.mjs` → `index.mjs`。ESM 能处理大部分循环，
 * 但这种依赖顺序的坑不值得踩。
 *
 * 抽到这里，依赖就是单向的：`index.mjs` → `commands/index.mjs`，
 * `help.mjs` → `commands/index.mjs`。
 */

/**
 * 每项：
 * - `summary` —— `--help` 里显示的一行说明
 * - `needsServer` —— 要不要 server 在跑
 * - `load` —— 动态加载命令模块（不加载就不用付这个代价）
 * - `run` —— 调用命令模块里的函数
 */
export const COMMANDS = {
  create: {
    summary: "生成一个世界（要几分钟）",
    needsServer: false,
    load: () => import("./create.mjs"),
    run: (m, ctx) => m.cmdCreate(ctx),
  },
  worlds: {
    summary: "列出所有世界",
    needsServer: false,
    load: () => import("./worlds.mjs"),
    run: (m, ctx) => m.cmdWorlds(ctx),
  },
  world: {
    summary: "看一个世界的详情",
    needsServer: false,
    load: () => import("./world.mjs"),
    run: (m, ctx) => m.cmdWorld(ctx),
  },
  locations: {
    summary: "列出世界的地点",
    needsServer: false,
    load: () => import("./locations.mjs"),
    run: (m, ctx) => m.cmdLocations(ctx),
  },
  status: {
    summary: "看模拟当前状态",
    needsServer: true,
    load: () => import("./status.mjs"),
    run: (m, ctx) => m.cmdStatus(ctx),
  },
  tick: {
    summary: "推进一个 tick（--count N 推进多个）",
    needsServer: true,
    load: () => import("./tick.mjs"),
    run: (m, ctx) => m.cmdTick(ctx),
  },
  characters: {
    summary: "列出角色和他们在干什么",
    needsServer: true,
    load: () => import("./characters.mjs"),
    run: (m, ctx) => m.cmdCharacters(ctx),
  },
  events: {
    summary: "看事件流（--limit / --type / --actor 过滤）",
    needsServer: true,
    load: () => import("./events.mjs"),
    run: (m, ctx) => m.cmdEvents(ctx),
  },
  rules: {
    summary: "看 / 改世界规则（转发给 scripts/rules.mjs）",
    needsServer: false,
    load: () => import("./rules.mjs"),
    run: (m, ctx) => m.cmdRules(ctx),
  },
  timeline: {
    summary: "快照 / 分叉 / 对比（转发给 scripts/timeline.mjs）",
    needsServer: false,
    load: () => import("./timeline.mjs"),
    run: (m, ctx) => m.cmdTimeline(ctx),
  },
  plugins: {
    summary: "列出已加载的插件（不跑钩子）",
    needsServer: false,
    load: () => import("./plugins.mjs"),
    run: (m, ctx) => m.cmdPlugins(ctx),
  },
  help: {
    summary: "显示这份帮助",
    needsServer: false,
    load: () => import("./help.mjs"),
    run: (m, ctx) => m.cmdHelp(ctx),
  },
};
