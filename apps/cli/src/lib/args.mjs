/**
 * 参数解析 —— CLI 共用。
 *
 * ## 为什么自己写而不用现成的库
 *
 * 命令行参数解析看起来是个「用库比较省事」的场景，但这里有个具体需求：
 * **`--world` 之后跟路径时，不能把路径当成子命令**。
 *
 * 通用库大多要求「选项在子命令之前」或者用 `--opt=value` 语法。
 * 而这里的命令长这样：
 *
 * ```
 * own-world tick --world output/worlds/xxx
 * own-world snapshot <timelineId> --desc "备注"
 * ```
 *
 * `--world` 后面跟的是**任意路径**（可能含 `/`、`.`），
 * 还可能跟一个 `--flag`。自己写 40 行能精确控制，
 * 引一个库反而要跟它的约定较劲。
 */

/**
 * 解析命令行参数。
 *
 * @param {string[]} argv 不含 `node` 和脚本路径的部分
 * @returns {{
 *   command: string|null,        // 第一个非选项参数
 *   positionals: string[],       // 其余非选项参数
 *   options: Record<string, string|boolean>,  // --key value 或 --flag
 *   flags: Set<string>,          // 所有出现过的选项名（含有值的）
 * }}
 */
export function parseArgs(argv) {
  const options = {};
  const positionals = [];
  const flags = new Set();

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (token.startsWith("--")) {
      const key = token.slice(2);
      flags.add(key);

      // 下一个 token 不是选项 → 它是这个选项的值
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        options[key] = next;
        i++;
      } else {
        options[key] = true;
      }
      continue;
    }

    positionals.push(token);
  }

  return {
    command: positionals[0] ?? null,
    positionals: positionals.slice(1),
    options,
    flags,
  };
}

/**
 * 取一个选项的值。
 *
 * @param {Record<string, string|boolean>} options
 * @param {string} key
 * @param {string|null} [fallback]
 * @returns {string|null}
 */
export function opt(options, key, fallback = null) {
  const value = options[key];
  if (value === undefined || value === true) return fallback;
  return value;
}

/**
 * 选项是否被给了（不管有没有值）。
 *
 * @param {Set<string>} flags
 * @param {string} key
 * @returns {boolean}
 */
export function has(flags, key) {
  return flags.has(key);
}
