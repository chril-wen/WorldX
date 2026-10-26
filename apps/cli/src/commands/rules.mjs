/**
 * `own-world rules` —— 改世界规则。
 *
 * ## 为什么不重写一份
 *
 * `scripts/rules.mjs` 已经能做这些，而且它**是规则的唯一写入口** ——
 * 越界的值会被钳制、别名会被规范化，都是有讲究的。
 *
 * 重写一份只会得到两套行为不一致的实现（而且其中一套很可能漏掉钳制），
 * 那比「CLI 只能改一部分规则」更糟。
 *
 * 所以这里**转发**给那个脚本。
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { PROJECT_DIR } from "../lib/world-paths.mjs";

const SCRIPT = path.join(PROJECT_DIR, "scripts", "rules.mjs");

/**
 * 转发给 `scripts/rules.mjs`。
 *
 * @param {object} ctx
 */
export async function cmdRules({ positionals, options }) {
  const args = [...positionals];

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
    process.exit(err.status ?? 1);
  }
}
