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

  function loadFrom(cwd: string): string {
    return execFileSync(
      process.execPath,
      [path.join(REPO_ROOT, "server/node_modules/tsx/dist/cli.mjs"), "-e", SCRIPT],
      { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  }

  it("从 server/ 和仓库根读到的模板完全一致", () => {
    const fromServer = loadFrom(path.join(REPO_ROOT, "server"));
    const fromRoot = loadFrom(REPO_ROOT);
    expect(fromServer).toBe(fromRoot);
  });

  it("两个 cwd 下都真的读到了模板（没报 ERROR）", () => {
    for (const cwd of [path.join(REPO_ROOT, "server"), REPO_ROOT]) {
      const result = loadFrom(cwd);
      expect(result).not.toContain("ERROR");
      for (const part of result.split("|")) {
        const len = Number(part.split(":")[1]);
        expect(len).toBeGreaterThan(0);
      }
    }
  });
});
