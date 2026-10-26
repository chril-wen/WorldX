import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_ROOT } from "./repo-paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 这条测试是**阶段 2 查出来的那个 bug 的守门人**。
 *
 * bug：`config-loader.ts` 的 CONFIGS_DIR 按进程 cwd 解析，
 * 从仓库根启动 server 时解析到 `E:\WordX\configs`（不存在），
 * 所有提示词模板都读不到 —— expand 那条路有 fallback 会静默降级，
 * 对话 / 反思 / 日记那些没有兜底会直接抛错。
 *
 * 光断言「路径长什么样」不够 —— 得真的**换个 cwd 跑一遍真的 loader**，
 * 确认读到的内容一样。
 */
describe("提示词模板读取不依赖 cwd", () => {
  /**
   * 在指定 cwd 下跑子进程，调用**真的** `loadPromptTemplate`，
   * 把读到的模板长度输出出来。
   */
  const SCRIPT = `
    import { loadPromptTemplate } from ${JSON.stringify(
      path.join(__dirname, "config-loader.ts"),
    )};
    const names = ["world-creation", "world-expansion", "dialogue", "diary"];
    const out = names.map((n) => {
      try {
        return n + ":" + loadPromptTemplate(n).length;
      } catch (err) {
        return n + ":ERROR:" + (err && err.code);
      }
    });
    console.log(out.join("|"));
  `;

  /**
   * 在指定 cwd 下跑子进程，调用**真的** `loadPromptTemplate`，
   * 把读到的模板长度输出出来。
   *
   * ## 为什么这里要重试
   *
   * 这条测试会 spawn 一个 tsx 子进程（每次约 1.8 秒）。
   * vitest 默认同时起 29 个 worker，Windows 上并发 spawn 子进程
   * 会偶发失败（进程没起来 / 管道写不进去）——
   * 那是**环境噪声**，不是被测代码坏了。
   *
   * 重试只针对「子进程起不来」这一种失败；
   * 断言本身一点都不放松 —— 模板读不到照样会红。
   */
  function loadFrom(cwd: string): string {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return execFileSync(
          process.execPath,
          [path.join(REPO_ROOT, "server/node_modules/tsx/dist/cli.mjs"), "-e", SCRIPT],
          { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
        ).trim();
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  // ⚠ 显式给 30 秒预算。
  //
  // 每个 cwd 要 spawn 一个 tsx 子进程（约 2.3 秒），两个 cwd ≈ 4.6 秒 ——
  // vitest 的**默认** timeout 是 5 秒，只剩 300ms 余量。
  // 全量跑的时候 CPU 一有竞争（别的测试文件在跑）就超时。
  //
  // 这不是放宽断言 —— 断言一点没动，模板读不到照样红。
  // 只是给「本来就慢」的测试够用的时间。

  it("从 server/ 和仓库根读到的模板完全一致", () => {
    const fromServer = loadFrom(path.join(REPO_ROOT, "server"));
    const fromRoot = loadFrom(REPO_ROOT);
    expect(fromServer).toBe(fromRoot);
  }, 30_000);

  it("两个 cwd 下都真的读到了模板（没报 ERROR）", () => {
    for (const cwd of [path.join(REPO_ROOT, "server"), REPO_ROOT]) {
      const result = loadFrom(cwd);
      expect(result).not.toContain("ERROR");
      for (const part of result.split("|")) {
        const len = Number(part.split(":")[1]);
        expect(len).toBeGreaterThan(0);
      }
    }
  }, 30_000);
});
