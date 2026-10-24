import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * expand-map 自检（124 条断言）接入 vitest。
 *
 * 做法：不重写那 914 行脚本 —— 它的夹具（与真实世界同构的 TMJ、mask 像素、
 * 地块几何）已经很成熟，重写风险高。改为把它当子进程跑，解析它的 PASS/FAIL
 * 输出，**为每一条断言生成一个独立的 vitest 用例**。
 *
 * 好处：
 * - 断言粒度不变（一条断言挂一个用例，失败能定位到具体是哪条）
 * - 脚本仍是唯一事实来源，日后加断言不用改这个文件
 * - 子进程退出码非 0 时，用例整体失败
 *
 * 原来的用法（node orchestrator/src/expand-map.selfcheck.mjs）依然可用。
 *
 * 注意：这里用顶层 await 而不是 beforeAll —— vitest 的 it() 在**收集阶段**
 * 就被调用，beforeAll 运行时用例列表已经定型，那样每条断言都生成不出来。
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "expand-map.selfcheck.mjs");

interface Assertion {
  label: string;
  passed: boolean;
  detail: string;
}

function runSelfcheck(): { assertions: Assertion[]; exitCode: number; stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  try {
    stdout = execFileSync(process.execPath, [SCRIPT], {
      encoding: "utf-8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err: any) {
    exitCode = typeof err.status === "number" ? err.status : 1;
    stdout = err.stdout ?? "";
    stderr = err.stderr ?? "";
  }

  const assertions = stdout
    .split("\n")
    // 脚本的输出行带缩进，用正则从行内提取 PASS/FAIL
    .map((line) => {
      const m = line.match(/\b(PASS|FAIL)\s{2}(.+)$/);
      if (!m) return null;
      const failed = m[1] === "FAIL";
      const body = m[2].trim();
      const arrow = body.indexOf("  -> ");
      return {
        label: arrow === -1 ? body : body.slice(0, arrow),
        passed: !failed,
        detail: arrow === -1 ? "" : body.slice(arrow + 5),
      };
    })
    .filter((x): x is Assertion => x !== null);

  return { assertions, exitCode, stdout, stderr };
}

const result = runSelfcheck();

describe("expand-map 自检", () => {
  it("脚本能跑完且退出码为 0", () => {
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("产出了断言结果", () => {
    expect(result.assertions.length).toBeGreaterThan(0);
  });

  it("断言数量不少于 120 条（防止脚本被误删）", () => {
    expect(result.assertions.length).toBeGreaterThanOrEqual(120);
  });

  // 为每一条断言生成一个独立用例 —— 失败时能精确定位到是哪条
  for (const a of result.assertions) {
    it(a.label, () => {
      expect(a.passed, a.detail).toBe(true);
    });
  }
});
