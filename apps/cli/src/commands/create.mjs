/**
 * `worldx create "<描述>"` —— 生成一个世界。
 *
 * ## 为什么要单独一条命令
 *
 * 世界生成要**几分钟**（画地图、视觉模型定位区域、生成角色立绘），
 * 期间 LLM 的输出是随机的 —— 同一个描述跑两次结果不一样。
 *
 * 所以 `worldx create` 做两件事：
 *
 * 1. 调 `orchestrator/src/index.mjs` 生成世界
 * 2. **把过程实时打出来** —— 不然用户面对几分钟的静默会以为卡死了
 *
 * 现有的 `npm run create` 也能用，但那是「一条命令跑完」；
 * CLI 这条把输出打得更清楚。
 *
 * ## 为什么用 spawn 而不是 execFileSync
 *
 * 需要**实时输出**。`execFileSync` 会等子进程结束才返回，
 * 那样用户看不到任何进度。
 *
 * ## 参数
 *
 * orchestrator 只接**位置参数**（那句描述），没有别的开关。
 * 所以这里不造不存在的选项 —— 传了 orchestrator 也不认。
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { PROJECT_DIR } from "../lib/world-paths.mjs";

const ORCHESTRATOR = path.join(PROJECT_DIR, "orchestrator", "src", "index.mjs");

/**
 * 生成世界。
 *
 * @param {object} ctx
 */
export async function cmdCreate({ positionals }) {
  const prompt = positionals.join(" ").trim();
  if (!prompt) {
    throw new Error('要一句描述，比如：worldx create "一个江南水乡的茶馆"');
  }

  console.log(`生成世界：${prompt}`);
  console.log("（可能要几分钟 —— 画地图、定位区域、生成立绘）\n");

  const code = await new Promise((resolve) => {
    const child = spawn("node", [ORCHESTRATOR, prompt], {
      cwd: PROJECT_DIR,
      stdio: "inherit",
    });
    child.on("error", (err) => {
      console.error(`错误：启动失败：${err.message}`);
      resolve(1);
    });
    child.on("close", (exitCode) => resolve(exitCode ?? 1));
  });

  if (code !== 0) {
    throw new Error(`生成失败（退出码 ${code}）`);
  }

  console.log("\n生成完成。看看有哪些世界：worldx worlds");
}
