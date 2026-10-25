import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `npm run rules` CLI 的测试。
 *
 * CLI 是「世界可控 L2」唯一的人机界面 —— 它坏了，
 * 规则就还是只能改代码才能改。所以它的行为要锁住。
 *
 * 跑的是**真的脚本**（子进程），不是 import 进来调函数 ——
 * 那样测不到参数解析、退出码、路径拼接这些真正会出错的地方。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const SCRIPT = join(REPO_ROOT, "scripts", "rules.mjs");

const TMJ = {
  width: 32,
  height: 32,
  tilewidth: 16,
  tileheight: 16,
  infinite: false,
  layers: [
    { name: "regions", type: "objectgroup", objects: [] },
    { name: "interactive_objects", type: "objectgroup", objects: [] },
    { name: "collision", type: "objectgroup", objects: [] },
  ],
};

let worldDir: string;

function writeWorldJson(data: unknown): string {
  const p = join(worldDir, "config", "world.json");
  writeFileSync(p, JSON.stringify(data, null, 2), "utf-8");
  return p;
}

function writeChar(id: string, name: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(
    join(worldDir, "config", "characters", `${id}.json`),
    JSON.stringify({ id, name, role: "NPC", ...extra }, null, 2),
    "utf-8",
  );
}

function run(args: string[]): { stdout: string; code: number } {
  try {
    const stdout = execFileSync("node", [SCRIPT, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, code: 0 };
  } catch (err: any) {
    return { stdout: `${err.stdout ?? ""}${err.stderr ?? ""}`, code: err.status ?? 1 };
  }
}

beforeEach(() => {
  worldDir = mkdtempSync(join(REPO_ROOT, "orchestrator", "src", ".tmp-rules-cli-"));
  mkdirSync(join(worldDir, "config", "characters"), { recursive: true });
  mkdirSync(join(worldDir, "map"), { recursive: true });
  writeFileSync(join(worldDir, "map", "06-final.tmj"), JSON.stringify(TMJ), "utf-8");
  writeWorldJson({
    worldName: "测试世界",
    locations: [{ id: "main_area", name: "主区域", description: "d", objects: [] }],
  });
  writeChar("char_a", "甲");
  writeChar("char_b", "乙");
});

afterEach(() => {
  rmSync(worldDir, { recursive: true, force: true });
});

describe("npm run rules -- list", () => {
  it("列出所有规则组和默认值", () => {
    const { stdout, code } = run(["list"]);
    expect(code).toBe(0);
    for (const group of ["emotion", "needs", "memory", "perception", "action"]) {
      expect(stdout).toContain(`【${group}】`);
    }
    expect(stdout).toContain("emotion.decayRate = 0.95");
  });
});

describe("npm run rules -- show", () => {
  it("显示当前世界的规则", () => {
    const { stdout, code } = run(["show", "--world", worldDir]);
    expect(code).toBe(0);
    expect(stdout).toContain("测试世界");
    expect(stdout).toContain("decayRate = 0.95");
  });

  it("没有 rules 段时说明用的是默认值", () => {
    const { stdout } = run(["show", "--world", worldDir]);
    expect(stdout).toContain("还没写 rules 段");
  });

  it("显示某角色生效的规则", () => {
    const { stdout, code } = run(["show", "char_a", "--world", worldDir]);
    expect(code).toBe(0);
    expect(stdout).toContain("甲");
  });

  it("可以按角色名找（不只 id）", () => {
    const { stdout, code } = run(["show", "甲", "--world", worldDir]);
    expect(code).toBe(0);
    expect(stdout).toContain("char_a");
  });
});

describe("npm run rules -- set", () => {
  it("世界级规则写进 world.json", () => {
    const { stdout, code } = run([
      "set",
      "emotion.decayRate",
      "0.9",
      "--world",
      worldDir,
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain("已设置世界规则");

    const world = JSON.parse(
      readFileSync(join(worldDir, "config", "world.json"), "utf-8"),
    );
    expect(world.rules).toEqual({ emotion: { decayRate: 0.9 } });
  });

  it("角色级规则写进角色配置文件", () => {
    const { code } = run([
      "set",
      "char_a",
      "memory.recencyDecayRate",
      "0.5",
      "--world",
      worldDir,
    ]);
    expect(code).toBe(0);

    const char = JSON.parse(
      readFileSync(join(worldDir, "config", "characters", "char_a.json"), "utf-8"),
    );
    expect(char.rules).toEqual({ memory: { recencyDecayRate: 0.5 } });
  });

  it("只写要改的项，不动其它规则", () => {
    run(["set", "emotion.decayRate", "0.9", "--world", worldDir]);
    run(["set", "memory.recencyDecayRate", "0.2", "--world", worldDir]);

    const world = JSON.parse(
      readFileSync(join(worldDir, "config", "world.json"), "utf-8"),
    );
    expect(world.rules).toEqual({
      emotion: { decayRate: 0.9 },
      memory: { recencyDecayRate: 0.2 },
    });
  });

  it("别名能解析到规范名（ROADMAP 里的 emotion.decay）", () => {
    const { code } = run(["set", "emotion.decay", "0.8", "--world", worldDir]);
    expect(code).toBe(0);
    const world = JSON.parse(
      readFileSync(join(worldDir, "config", "world.json"), "utf-8"),
    );
    // 落盘的是规范名 decayRate
    expect(world.rules).toEqual({ emotion: { decayRate: 0.8 } });
  });

  it("规则组不存在时报错", () => {
    const { stdout, code } = run([
      "set",
      "emotionn.decayRate",
      "0.9",
      "--world",
      worldDir,
    ]);
    expect(code).not.toBe(0);
    expect(stdout).toContain("没有规则组");
  });

  it("规则键不存在时报错并列出可用的", () => {
    const { stdout, code } = run([
      "set",
      "emotion.不存在的键",
      "0.9",
      "--world",
      worldDir,
    ]);
    expect(code).not.toBe(0);
    expect(stdout).toContain("decayRate");
  });

  it("非数字值报错", () => {
    const { stdout, code } = run([
      "set",
      "emotion.decayRate",
      "很快",
      "--world",
      worldDir,
    ]);
    expect(code).not.toBe(0);
    expect(stdout).toContain("必须是数字");
  });

  it("角色不存在时报错", () => {
    const { stdout, code } = run([
      "set",
      "char_zzz",
      "memory.recencyDecayRate",
      "0.5",
      "--world",
      worldDir,
    ]);
    expect(code).not.toBe(0);
    expect(stdout).toContain("找不到角色");
  });

  it("值不合理时给出警告但仍然写入", () => {
    const { stdout, code } = run([
      "set",
      "emotion.decayRate",
      "5",
      "--world",
      worldDir,
    ]);
    // 写进去了（CLI 不擅自拒绝用户的意图）
    expect(code).toBe(0);
    // 但明确警告了
    expect(stdout).toContain("不合理");
  });
});

describe("npm run rules -- reset", () => {
  it("重置世界全部规则", () => {
    run(["set", "emotion.decayRate", "0.9", "--world", worldDir]);
    const { code } = run(["reset", "--world", worldDir]);
    expect(code).toBe(0);

    const world = JSON.parse(
      readFileSync(join(worldDir, "config", "world.json"), "utf-8"),
    );
    expect(world.rules).toBeUndefined();
  });

  it("重置单个规则项，其它保留", () => {
    run(["set", "emotion.decayRate", "0.9", "--world", worldDir]);
    run(["set", "memory.recencyDecayRate", "0.2", "--world", worldDir]);
    run(["reset", "emotion.decayRate", "--world", worldDir]);

    const world = JSON.parse(
      readFileSync(join(worldDir, "config", "world.json"), "utf-8"),
    );
    expect(world.rules).toEqual({ memory: { recencyDecayRate: 0.2 } });
  });

  it("重置角色级 override", () => {
    run(["set", "char_a", "memory.recencyDecayRate", "0.5", "--world", worldDir]);
    run(["reset", "char_a", "--world", worldDir]);

    const char = JSON.parse(
      readFileSync(join(worldDir, "config", "characters", "char_a.json"), "utf-8"),
    );
    expect(char.rules).toBeUndefined();
  });

  it("重置后文件跟改之前完全一致（不留残骸）", () => {
    const before = readFileSync(join(worldDir, "config", "world.json"), "utf-8");
    run(["set", "emotion.decayRate", "0.9", "--world", worldDir]);
    run(["reset", "--world", worldDir]);
    const after = readFileSync(join(worldDir, "config", "world.json"), "utf-8");
    expect(after).toBe(before);
  });
});

describe("CLI 的用法提示", () => {
  it("没有命令时打印用法并返回非零", () => {
    const { stdout, code } = run([]);
    expect(code).not.toBe(0);
    expect(stdout).toContain("用法");
  });

  it("未知命令时打印用法", () => {
    const { stdout, code } = run(["瞎写"]);
    expect(code).not.toBe(0);
    expect(stdout).toContain("用法");
  });
});
