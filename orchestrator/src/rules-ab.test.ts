import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

/**
 * 长模拟对拍 —— 「规则真的接进整条链路」的验收。
 *
 * ## 为什么要有这个
 *
 * 阶段 2.5 的冒烟（`scripts/rules-smoke.mjs`）只验了 `tickPassiveUpdate`
 * —— 情绪衰减、好奇心衰减。那些是**纯函数**，不调模型。
 *
 * 但用户真正关心的是端到端：改一条记忆规则，角色的记忆、对话、
 * 反思会不会真的不一样。这个冒烟没覆盖。
 *
 * ## 这测试的是三件事
 *
 * 1. **A/A 对照** —— 同样规则跑两遍，差异必须是 0。
 *    这一步是整个测试的**前提**。如果两遍就有差异，说明链路里还有
 *    随机源（nanoid、时间戳、未固定的随机），那么 A/B 的差异就不能
 *    归给规则 —— 那个测试等于没测。
 *
 * 2. **A/B 对拍** —— 只改规则，行为必须变。
 *
 * 3. **方向性** —— 差异不只是「有」，还得「对」。
 *    巩固门限拉高，长期记忆就该变少。方向反了说明规则接到了别的地方。
 *
 * 跑的是**真的脚本**（子进程），因为确定性依赖脚本里注入的
 * 种子随机数和固定时钟 —— 那些是运行时注入的，import 进来测不到。
 *
 * 注意：跑之前必须 `npm run build:core` ——
 * 脚本 import 的是 core 的 `dist/`，不是源码。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const SCRIPT = join(REPO_ROOT, "scripts", "rules-ab.mjs");

/** core 的 dist 必须是最新的 —— 脚本 import 的是它，不是源码。 */
function ensureCoreBuilt(): void {
  const dist = join(REPO_ROOT, "packages", "core", "dist", "index.js");
  if (!fs.existsSync(dist)) {
    throw new Error(
      "packages/core/dist 不存在 —— 先跑 `npm run build:core`。" +
        "脚本 import 的是 dist，不是源码。",
    );
  }
}

function runAb(extraArgs: string[] = [], ticks = 12): string {
  ensureCoreBuilt();
  try {
    return execFileSync("node", [SCRIPT, "--ticks", String(ticks), ...extraArgs], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    // 脚本用非零退出码表示「没差异」—— 那本身就是要看的结论
    const e = err as { stdout?: string; stderr?: string; status?: number };
    if (e.stdout) return e.stdout;
    throw err;
  }
}

/**
 * 跑多少个 tick。
 *
 * **必须够长**：记忆的巩固（转长期记忆）要跨过日末才发生。
 * 12 个 tick 只能看到「有差异」，看不到「长期记忆变少」这个方向。
 * 30 个 tick 能跨过一整天，方向性差异才稳定。
 */
const TICKS_FOR_DIRECTION = 30;

describe("长模拟对拍 —— 规则接进了整条链路", () => {
  it("A/A 对照：同样规则跑两遍，差异必须是 0", () => {
    // 这是前提。链路不确定的话，后面的 A/B 对拍就是自欺欺人。
    const out = runAb(["--aa"]);

    expect(out).toContain("A/A 对照");
    expect(out).toMatch(/两遍完全一致|两遍有 \d+ 处不同/);

    // 明确断言「完全一致」—— 有随机源的话这里会红
    expect(out).toContain("两遍完全一致");
    expect(out).not.toMatch(/⚠️ 两遍有 \d+ 处不同/);
  }, 300_000);

  it("A/B 对拍：只改规则，行为必须变", () => {
    const out = runAb();

    // 规则改了必须有差异
    expect(out).toMatch(/✅ \d+ 处不同/);
    expect(out).not.toContain("两轮完全一样");
  }, 300_000);

  it("方向性：巩固门限拉高，长期记忆必须变少", () => {
    const out = runAb([], TICKS_FOR_DIRECTION);

    // 脚本自己会断言方向，但这里再独立查一遍 ——
    // 脚本的断言逻辑写错了的话，测试也得能抓。
    expect(out).toContain("方向性断言");
    expect(out).not.toContain("❌");

    // 至少有一个角色出现「长期记忆变少」
    const rows = [...out.matchAll(/长期记忆 (\d+) → (\d+)/g)];
    expect(rows.length).toBeGreaterThan(0);
    const decreased = rows.filter(([, a, b]) => Number(b) < Number(a));
    expect(decreased.length).toBeGreaterThan(0);
  }, 300_000);
});
