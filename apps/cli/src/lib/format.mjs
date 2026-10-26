/**
 * 输出格式 —— CLI 共用。
 *
 * ## 为什么要管输出格式
 *
 * CLI 的输出有两个消费者：
 *
 * 1. **人** —— 要能一眼看懂
 * 2. **脚本** —— `worldx tick --json | jq` 要能用
 *
 * 所以每个能输出数据的命令都支持 `--json`：加了它就输出纯 JSON，
 * 不加就输出给人看的表格。
 *
 * 两种格式**从同一份数据生成** —— 不写两遍逻辑，
 * 免得「表格里有的字段 JSON 里没有」这种不一致。
 */

/**
 * 打印数据。
 *
 * @param {object} options
 * @param {unknown} options.data 要输出的数据
 * @param {string} options.json JSON 字符串（已经序列化好）
 * @param {boolean} options.asJson 用户要 JSON 吗
 * @param {() => void} options.human 人类可读版本的打印函数
 */
export function emit({ data, json, asJson, human }) {
  if (asJson) {
    console.log(json ?? JSON.stringify(data, null, 2));
    return;
  }
  human();
}

/**
 * 打印一张对齐的表。
 *
 * @param {Array<{label: string, value: string}>} rows
 */
export function printRows(rows) {
  if (rows.length === 0) return;
  const width = Math.max(...rows.map((r) => r.label.length));
  for (const row of rows) {
    console.log(`  ${row.label.padEnd(width)}  ${row.value}`);
  }
}

/**
 * 打印一个标题 + 内容块。
 *
 * @param {string} title
 * @param {() => void} body
 */
export function section(title, body) {
  console.log(`\n${title}`);
  console.log("─".repeat(title.length + 2));
  body();
}

/**
 * 打印错误并退出。
 *
 * @param {unknown} err
 * @param {number} [code]
 */
export function fail(err, code = 1) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`错误：${message}`);
  process.exit(code);
}
