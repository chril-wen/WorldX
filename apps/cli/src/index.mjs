#!/usr/bin/env node
/**
 * `worldx` —— WorldX 命令行工具。
 *
 * ## 为什么要有 CLI
 *
 * WorldX 的主界面是浏览器里的 Phaser + React。但**有些事在终端里更顺手**：
 *
 * - 跑 tick 看事件流 —— 不用开浏览器
 * - 改规则看效果 —— 改完立刻 reload 对拍
 * - 快照/分叉/对比 —— 这是 L3 的核心能力，本来就只能命令行做
 * - 脚本化 —— `worldx tick --count 10` 塞进别的流程里
 *
 * ## 哪些命令要 server，哪些不要
 *
 * | 命令 | 要 server | 为什么 |
 * |---|---|---|
 * | `worlds` `world` `locations` | ❌ | 纯文件系统 |
 * | `rules` `timeline` | ❌ | 纯文件系统 |
 * | `create` | ❌ | 自己 spawn orchestrator |
 * | `status` `tick` `characters` `events` | ✅ | 状态在 server 内存/数据库里 |
 *
 * 不需要 server 的命令**在 server 没跑的时候也能用** ——
 * 这是有意的：规则和快照是离线资产，不该因为「没开服务」就动不了。
 *
 * ## 跟已有脚本的关系
 *
 * `rules` 和 `timeline` 两个命令是**转发**给 `scripts/` 下那两个脚本的，
 * 不是重写 —— 重写会产生两套行为不一致的实现。
 * 详见 `apps/cli/src/commands/rules.mjs` 的注释。
 */

import { parseArgs } from "./lib/args.mjs";
import { COMMANDS } from "./commands/index.mjs";
import { fail } from "./lib/format.mjs";

/**
 * 打印帮助。
 */
async function printHelp() {
  const mod = await import("./commands/help.mjs");
  mod.printHelp(COMMANDS);
}

async function main() {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);

  // 没有命令、或者显式 help → 打帮助
  if (!parsed.command || parsed.command === "help" || parsed.flags.has("help")) {
    if (parsed.command && parsed.command !== "help" && !COMMANDS[parsed.command]) {
      // 未知命令也算要帮助，但提示一下
      await printHelp();
      console.error(`\n未知命令：${parsed.command}`);
      process.exit(1);
    }
    await printHelp();
    return;
  }

  const entry = COMMANDS[parsed.command];
  if (!entry) {
    await printHelp();
    console.error(`\n未知命令：${parsed.command}`);
    process.exit(1);
  }

  const mod = await entry.load();
  await entry.run(mod, {
    positionals: parsed.positionals,
    options: parsed.options,
    flags: parsed.flags,
    command: parsed.command,
  });
}

main().catch((err) => fail(err));
