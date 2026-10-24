import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import {
  SERVER_ROOT,
  REPO_ROOT,
  PROMPTS_DIR,
  CONFIG_DIR,
  SERVER_DATA_DIR,
  OUTPUT_WORLDS_DIR,
  LIBRARY_WORLDS_DIR,
  CLIENT_DIST_DIR,
} from "./repo-paths.js";

/**
 * 守住一个已经活了几周的 bug：
 * 以前配置目录是 `fs.existsSync(path.resolve("configs")) ? ... : ...` ——
 * 按进程 cwd 解析。从 `server/` 启动能找到，从仓库根启动就找不到了，
 * 而且**找错不报错**：提示词读不到会静默降级，数据库会写到别处去。
 *
 * 所以这里断言的��是「路径长什么样」，而是「**不管从哪启动都一样**」。
 */
describe("repo-paths", () => {
  it("从仓库根推导，不依赖 cwd", () => {
    // `server/src/utils/` → `server/` → 仓库根
    expect(SERVER_ROOT.endsWith(`${path.sep}server`)).toBe(true);
    expect(REPO_ROOT).toBe(path.resolve(SERVER_ROOT, ".."));
    expect(path.basename(REPO_ROOT)).not.toBe("server");
  });

  it("所有目录都真实存在", () => {
    for (const dir of [
      SERVER_ROOT,
      REPO_ROOT,
      PROMPTS_DIR,
      CONFIG_DIR,
      SERVER_DATA_DIR,
      OUTPUT_WORLDS_DIR,
      LIBRARY_WORLDS_DIR,
    ]) {
      expect(fs.existsSync(dir), `${dir} 应该存在`).toBe(true);
    }
  });

  it("提示词目录里有模板", () => {
    const files = fs.readdirSync(PROMPTS_DIR).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain("world-creation.md");
    expect(files).toContain("world-expansion.md");
  });

  it("改名后不再有 design-world 这个歧义名", () => {
    const files = fs.readdirSync(PROMPTS_DIR);
    expect(files.some((f) => f.includes("design-world"))).toBe(false);
  });

  it("CLIENT_DIST_DIR 指向 client/dist（可能还没构建）", () => {
    expect(CLIENT_DIST_DIR.endsWith(path.join("client", "dist"))).toBe(true);
  });
});
