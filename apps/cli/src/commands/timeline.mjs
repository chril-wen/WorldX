/**
 * `own-world timeline` —— 快照 / 分叉 / 对比。
 *
 * ## 为什么不重写一份
 *
 * `scripts/timeline.mjs` 已经能做这些，而且**直接操作文件系统**，
 * 不依赖 server 在跑 —— 快照和分叉是纯文件操作。
 *
 * 重写一份只会得到两套行为不一致的实现。所以这里
 * **转发**给那个脚本，参数原样传过去。
 *
 * ## 打印为什么在 CLI 这边
 *
 * 脚本用 `--json` 跑，输出结构化数据；CLI 拿到后自己打印。
 *
 * 之前是 `stdio: "inherit"` —— 脚本自己打印，于是 `own-world timeline`
 * 的输出跟 CLI 其它命令**两套风格**（英文 `day 1 tick 21` vs
 * 中文标题 + `───` 分隔线）。
 *
 * 转发靠 `stdio: "inherit"` **拿不到返回值**，所以要么
 * 脚本自己按 CLI 风格打印（那 CLI 就只能照单全收，两边得同步改），
 * 要么脚本给数据、CLI 打印。
 *
 * 选后者：**显示层只有一份**（`lib/timeline-render.mjs`），
 * 脚本独立跑时也用它 —— 不会分叉出两套风格。
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { PROJECT_DIR } from "../lib/world-paths.mjs";
import {
  renderDiff,
  renderForked,
  renderRestored,
  renderSnapshotCreated,
  renderSnapshotList,
  renderTimelineList,
} from "../lib/timeline-render.mjs";

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
 * 转发给 `scripts/timeline.mjs`，拿它的 JSON 输出。
 *
 * @param {string[]} args 已经带好 `--json` 的参数
 * @returns {any} 脚本输出的结构化数据
 */
function runScript(args) {
  try {
    const stdout = execFileSync("node", ["--import", TSX_LOADER, SCRIPT, ...args], {
      cwd: PROJECT_DIR,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(stdout);
  } catch (err) {
    // 脚本用 exit(1) 表示失败 —— 它的 stderr 是给人看的，直接转出去
    if (err.stderr) process.stderr.write(err.stderr);
    process.exit(err.status ?? 1);
  }
}

/**
 * `own-world timeline` 的入口。
 *
 * @param {object} ctx
 */
export async function cmdTimeline({ positionals, options, flags }) {
  const sub = positionals[0];
  if (!sub) {
    console.error("用法：own-world timeline <list|snapshots|snapshot|restore|fork|diff> ...");
    process.exit(1);
  }

  // 传给脚本的参数：子命令 + 其余位置参数 + 选项
  const args = [...positionals];
  for (const [key, value] of Object.entries(options)) {
    if (value === true) {
      args.push(`--${key}`);
    } else {
      args.push(`--${key}`, String(value));
    }
  }
  // 脚本用这个开关决定「给数据」还是「自己打印」
  args.push("--json");

  const data = runScript(args);

  // `--json` 给脚本用户 —— CLI 自己打印 JSON
  if (flags.has("json")) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  // 按子命令分派到对应的渲染
  switch (sub) {
    case "list":
      renderTimelineList(data);
      break;
    case "snapshots":
      renderSnapshotList(data);
      break;
    case "snapshot":
      renderSnapshotCreated(data);
      break;
    case "restore":
      renderRestored(data);
      break;
    case "fork":
      renderForked(data);
      break;
    case "diff": {
      // `actionLabel` 来自 core（TypeScript）——
      // CLI 是纯 .mjs，用 core-loader 动态加载。
      const { loadEventFormat } = await import("../lib/core-loader.mjs");
      const { actionLabel } = await loadEventFormat();
      renderDiff({ ...data, actionLabel });
      break;
    }
    default:
      console.error(`未知的 timeline 子命令：${sub}`);
      process.exit(1);
  }
}
