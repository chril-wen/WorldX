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
    execFileSync("node", [SCRIPT, ...args], {
      cwd: PROJECT_DIR,
      stdio: "inherit",
    });
  } catch (err) {
    // 脚本用 exit(1) 表示失败 —— 直接把码传出去
    process.exit(err.status ?? 1);
  }
}
