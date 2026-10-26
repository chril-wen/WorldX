/**
 * `own-world help` —— 命令表。
 *
 * ## 为什么分两个文件
 *
 * `index.mjs` 要 import 所有命令模块才能列出来 ——
 * 但那会让「只想看帮助」也加载一遍所有命令。
 *
 * 这里把「命令表」留在 `index.mjs`（它必须在那里才能分发），
 * 而**帮助的打印**在这个文件里 —— `index.mjs` 用动态 import 调它。
 */

/**
 * 打印帮助。
 *
 * @param {Record<string, {summary: string, needsServer: boolean}>} commands
 */
export function printHelp(commands) {
  console.log("own-world —— OWN-World 命令行工具\n");
  console.log("用法：own-world <命令> [选项]\n");
  console.log("命令：");

  const width = Math.max(...Object.keys(commands).map((k) => k.length));
  for (const [name, entry] of Object.entries(commands)) {
    // 两种都标 —— 只标「要 server」的话，
    // 看到没标记的还得去翻文档才知道它**不需要** server。
    const marker = entry.needsServer ? " [要 server]" : " [离线可用]";
    console.log(`  ${name.padEnd(width)}  ${entry.summary}${marker}`);
  }

  console.log("\n通用选项：");
  console.log("  --world <id|路径>  指定世界（默认：最近生成的那个）");
  console.log("  --json             输出 JSON（给脚本用）");
  console.log("  --help             显示这份帮助");

  console.log("\n例子：");
  console.log('  own-world create "一个江南水乡的茶馆"');
  console.log("  own-world worlds");
  console.log("  own-world tick --count 10");
  console.log("  own-world characters");
  console.log("  own-world rules show");
  console.log("  own-world rules set emotion.decayRate 0.9");
  console.log("  own-world timeline snapshot <timelineId> --desc \"分岔点\"");
  console.log("  own-world timeline fork <timelineId> <snapshotId> --label \"另一种可能\"");
  console.log("  own-world timeline diff <timelineA> <timelineB>");
}

/**
 * `own-world help` 命令的入口。
 */
export async function cmdHelp() {
  const { COMMANDS } = await import("./index.mjs");
  printHelp(COMMANDS);
}
