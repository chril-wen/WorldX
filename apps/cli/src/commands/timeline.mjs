/**
 * `worldx timeline` —— 快照 / 分叉 / 对比。
 *
 * ## 为什么不重写一份
 *
 * `scripts/timeline.mjs` 已经能做这些，而且**直接操作文件系统**，
 * 不依赖 server 在跑 —— 快照和分叉是纯文件操作。
 *
 * 重写一份只会得到两套行为不一致的实现。所以这里
 * **转发**给那个脚本，参数原样传过去。
 *
 * 唯一多做的事：把 `worldx timeline` 变成 `worldx timeline <子命令>`，
 * 也就是把脚本的「第一个参数」提升成 CLI 的「子命令」层级。
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { PROJECT_DIR } from "../lib/world-paths.mjs";

const SCRIPT = path.join(PROJECT_DIR, "scripts", "timeline.mjs");

/**
 * 用 `node --import tsx` 跑，不是纯 `node`。
 *
 * ## 为什么
 *
 * `scripts/timeline.mjs` 会 `import("../server/src/store/snapshot-store.ts")`
 * —— 直接 import TypeScript 源码。普通 `node` 加载 `.ts` 会报
 * 「Unknown file extension ".ts"」。
 *
 * `npm run timeline` 用的是 `tsx scripts/timeline.mjs`，所以它能跑。
 * CLI 转发时如果用纯 `node`，`snapshot` / `fork` / `restore` 这几个
 * **要碰 server 的 TS 模块**的子命令就会挂。
 *
 * ## 为什么用 `--import` 而不是 `node_modules/.bin/tsx`
 *
 * `.bin/tsx` 是个 shell 脚本（`#!/bin/sh`）—— Windows 上
 * `execFileSync` 不能直接执行它。
 *
 * `node --import tsx` 是 tsx 4.x 官方支持的加载器方式，
 * 跨平台，而且**不依赖 shell**。
 *
 * `tsx` 在根 `package.json` 的 `dependencies` 里（不是 devDependencies）——
 * 所以任何装了依赖的环境都能用。
 */
const TSX_LOADER = "tsx";

/**
 * 转发给 `scripts/timeline.mjs`。
 *
 * @param {object} ctx
 */
export async function cmdTimeline({ positionals, options }) {
  const args = [];

  // 子命令原样传
  args.push(...positionals);

  // 选项原样传
  for (const [key, value] of Object.entries(options)) {
    if (value === true) {
      args.push(`--${key}`);
    } else {
      args.push(`--${key}`, String(value));
    }
  }

  try {
    execFileSync("node", ["--import", TSX_LOADER, SCRIPT, ...args], {
      cwd: PROJECT_DIR,
      stdio: "inherit",
    });
  } catch (err) {
    // 脚本用 exit(1) 表示失败 —— 直接把码传出去
    process.exit(err.status ?? 1);
  }
}
