/**
 * CLI 的测试。
 *
 * ## 跑的是**真的进程**
 *
 * 不是 import 进来调函数 —— 那样测不到参数解析、退出码、
 * 动态 import 失败这些真正会出错的地方。
 *
 * 子进程跑 `node apps/cli/src/index.mjs`。
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const CLI = join(REPO_ROOT, "apps", "cli", "src", "index.mjs");

/**
 * 跑 CLI。
 *
 * @param {string[]} args
 * @param {Record<string, string>} [env] 额外环境变量
 * @returns {{stdout: string, stderr: string, code: number}}
 */
function run(args, env = {}) {
  try {
    const stdout = execFileSync("node", [CLI, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    return { stdout, stderr: "", code: 0 };
  } catch (err) {
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      code: err.status ?? 1,
    };
  }
}

/**
 * 指向一个**没人监听**的端口 —— 用来测「server 没跑」的情况。
 *
 * 端口 59999 是 IANA 保留的动态端口区间，实践中不会有人监听。
 */
const NO_SERVER = { WORLDX_SERVER: "http://localhost:59999" };

/**
 * 一个**确定存在**的世界。
 *
 * ## 为什么不依赖「当前世界」
 *
 * CLI 的「当前世界」= `output/worlds/` 下 mtime 最新的那个。
 * mtime 会因为别的进程（跑着的 server、timeline 脚本）变 ——
 * 测试依赖它就会 flaky。
 *
 * 所以显式指定。这个世界有 11 个地点、5 个角色、4 条时间线，
 * 内容足够全，能测出「读到什么」而不只是「没报错」。
 */
const KNOWN_WORLD = "world_2026-10-20T11-06-51";

describe("worldx help", () => {
  it("列出所有命令", () => {
    const { stdout, code } = run(["help"]);
    expect(code).toBe(0);

    // ROADMAP 验收标准：`npm run cli -- help` 列出所有命令
    for (const name of [
      "create",
      "worlds",
      "world",
      "locations",
      "status",
      "tick",
      "characters",
      "events",
      "rules",
      "timeline",
    ]) {
      expect(stdout).toContain(name);
    }
  });

  it("不带参数也打帮助", () => {
    const { stdout, code } = run([]);
    expect(code).toBe(0);
    expect(stdout).toContain("worldx");
  });

  it("未知命令退出码是 1", () => {
    const { code, stderr } = run(["没有这个命令"]);
    expect(code).toBe(1);
    expect(stderr).toContain("未知命令");
  });
});

describe("worldx worlds", () => {
  it("列出世界", () => {
    const { stdout, code } = run(["worlds"]);
    expect(code).toBe(0);
    expect(stdout).toContain("生成的世界");
  });

  it("--json 输出可解析的 JSON", () => {
    const { stdout, code } = run(["worlds", "--json"]);
    expect(code).toBe(0);

    const data = JSON.parse(stdout);
    expect(Array.isArray(data.worlds)).toBe(true);
    for (const w of data.worlds) {
      expect(typeof w.id).toBe("string");
      expect(typeof w.locations).toBe("number");
      expect(typeof w.characters).toBe("number");
    }
  });

  it("已知的那个世界在列表里，且内容对得上", () => {
    const { stdout, code } = run(["worlds", "--json"]);
    expect(code).toBe(0);

    const data = JSON.parse(stdout);
    const known = data.worlds.find((w) => w.id === KNOWN_WORLD);
    expect(known).toBeDefined();
    expect(known.name).toBe("水巷口老茶馆");
    expect(known.locations).toBe(11);
    expect(known.characters).toBe(5);
  });
});

describe("worldx world", () => {
  it("显示世界详情", () => {
    // 显式指定世界 —— 不依赖「当前世界」。
    //
    // 「当前世界」= `output/worlds/` 下 mtime 最新的那个，
    // 而 mtime 会因为别的进程（跑着的 server、timeline 脚本）变。
    // 测试依赖它就会 flaky。
    const { stdout, code } = run(["world", "--world", KNOWN_WORLD]);
    expect(code).toBe(0);
    expect(stdout).toContain("中心区域");
  });

  it("--world 指向不存在的世界时报错", () => {
    const { code, stderr } = run(["world", "--world", "根本没有这个世界"]);
    expect(code).toBe(1);
    expect(stderr).toContain("找不到世界");
  });
});

describe("worldx locations", () => {
  it("列出地点并做一致性检查", () => {
    const { stdout, code } = run(["locations", "--world", KNOWN_WORLD]);
    expect(code).toBe(0);
    expect(stdout).toContain("地点");
  });

  it("--json 里 divergence 字段在", () => {
    const { stdout, code } = run(["locations", "--world", KNOWN_WORLD, "--json"]);
    expect(code).toBe(0);

    const data = JSON.parse(stdout);
    expect(data.divergence).toBeDefined();
    expect(Array.isArray(data.divergence.onlyInTmj)).toBe(true);
    expect(Array.isArray(data.divergence.onlyInWorld)).toBe(true);
    // 中心区域是合法的例外，不该被算成「只在 world.json 里」
    expect(data.divergence.onlyInWorld).not.toContain(data.centerLocationId);
  });
});

describe("需要 server 的命令", () => {
  it("server 没跑时给出可操作的提示", () => {
    // 这些命令要 server。没跑的时候要**说清楚怎么启动**，
    // 而不是抛一个 ECONNREFUSED 的原始错误。
    //
    // 用一个没人监听的端口 —— 这样测试**不依赖**本机 server 跑没跑。
    for (const name of ["status", "tick", "characters", "events"]) {
      const { code, stderr } = run([name], NO_SERVER);
      expect(code).toBe(1);
      expect(stderr).toContain("server");
      expect(stderr).toContain("npm run dev:server");
    }
  });
});

describe("worldx timeline", () => {
  it("list 能跑（不需要 server）", () => {
    const { code } = run(["timeline", "list"]);
    expect(code).toBe(0);
  });

  it("snapshot 能加载 server 的 TS 模块", () => {
    // 回归测试：CLI 转发时如果用纯 `node` 跑 `scripts/timeline.mjs`，
    // 它 import server 的 `.ts` 就会报「Unknown file extension ".ts"」。
    //
    // 这个 bug 静默得很 —— `list` 能跑（不碰 TS 模块），
    // 只有 `snapshot` / `fork` / `restore` 才暴露。
    //
    // 用一个**不存在的** timeline id：报错来自 server 代码
    // （「Timeline not found」）而不是扩展名错误 —— 这恰好证明
    // TS 模块**加载成功了**。而且不产生快照，不污染世界目录。
    const { stdout, stderr, code } = run(["timeline", "snapshot", "没有这条时间线"]);
    expect(code).toBe(1);
    // 错误走 stderr
    expect(stderr).toContain("Timeline not found");
    expect(stderr).not.toContain("Unknown file extension");
  });
});
