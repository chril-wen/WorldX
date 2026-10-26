import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

/**
 * 守住两个曾经让**主流程整个跑不起来**的 bug。
 *
 * **bug 1：`export` 关键字被误删（2026-10-24，提交 6e16a7d）**
 *
 * `orchestrator/src/world-design-utils.mjs` 里的
 * `normalizeWorldDesign` 少了 `export`，ESM 的具名导出在**导入时**就检查，
 * 6 个 importer 全部起不来 —— 包括 orchestrator 的主入口。
 * 「创建世界」功能从那一刻起就坏了。
 *
 * **bug 2：相对 import 路径错了一级（2026-10-24，阶段 2 引入）**
 *
 * `generators/character/src/models/gemini-flash-img.mjs` 写的是
 * `../../../shared/models-config.mjs`，指到 `generators/shared/` ——
 * 那个目录**真实存在**（放绘图 provider），所以看起来像那么回事，
 * 但 `models-config.mjs` 在仓库根的 `shared/`。
 *
 * **为什么这两个 bug 能活这么久？**
 *
 * 因为这个仓库**没有任何测试 import 这些入口**。
 * 389 条用例全绿，但创建世界功能是坏的 —— 测试网在别的地方，
 * 坏的地方没人看。
 *
 * 这条测试就是那道网。它只做**模块解析**，不执行业务逻辑：
 * 快、无副作用、CI 里能跑。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");

/** 要扫的源码目录 —— 相对仓库根。 */
const SCAN_DIRS = ["orchestrator", "generators", "shared"];

/**
 * 收集所有 .mjs 文件（跳过 node_modules）。
 *
 * 为什么不扫 client/ 和 packages/：那两个是 TypeScript，
 * 走 tsc 编译，import 路径写错**编译期就会报错**，不会静默。
 * 只有 .mjs 这一半是运行时才解析的 —— 也就是会静默的那一半。
 *
 * ## 为什么跳过 `.tmp-*` 目录
 *
 * `plugins.test.ts` 会在 `orchestrator/src/.tmp-plugin-tests/` 里
 * 建临时插件文件，测完就删。
 *
 * 两条测试**并行跑**的时候，扫描器可能正好读到那个目录 ——
 * 然后文件在 `readFileSync` 之前被删了，抛 ENOENT。
 *
 * 这不是产品代码的 bug，是**测试自己的竞态**：
 * 扫的是别人的临时工作区。跳过以 `.tmp-` 开头的目录。
 */
function collectMjsFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    // 别的测试的临时工作区 —— 扫它会撞上文件被删的瞬间
    if (entry.name.startsWith(".tmp-")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectMjsFiles(full, out);
    } else if (entry.name.endsWith(".mjs")) {
      out.push(full);
    }
  }
  return out;
}

const ALL_MJS = SCAN_DIRS.flatMap((d) => collectMjsFiles(join(REPO_ROOT, d)));

/** 抓 `from "..."` 里的相对 specifier。 */
function relativeSpecifiers(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/from\s*["'](\.[^"']+)["']/g)) out.push(m[1]);
  return out;
}

/** 抓 `import { a, b as c } from "..."` 的具名导入。 */
function namedImports(
  source: string,
): Array<{ names: string[]; specifier: string }> {
  const out: Array<{ names: string[]; specifier: string }> = [];
  for (const m of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*["'](\.[^"']+)["']/g)) {
    const names = m[1]
      .split(",")
      .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    if (names.length) out.push({ names, specifier: m[2] });
  }
  return out;
}

/**
 * 静态导出名 —— 不真的 import 模块。
 *
 * 为什么静态够用：这个仓库里**没有 `export *`**（有测试守着），
 * 所以具名导出都能从源码里直接读出来。
 * 静态的好处是**不执行模块顶层** —— 而 `orchestrator/src/index.mjs`
 * 顶层会调 `main()`，import 一下就会真去生成世界。
 */
function staticExportNames(filePath: string): Set<string> {
  const source = readFileSync(filePath, "utf-8");
  const names = new Set<string>();

  // export function foo / export async function foo / export class Foo
  for (const m of source.matchAll(
    /export\s+(?:async\s+)?(?:function\*?|class)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    names.add(m[1]);
  }
  // export const foo = / export let foo = / export var foo =
  for (const m of source.matchAll(
    /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    names.add(m[1]);
  }
  // export { a, b as c }
  for (const m of source.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  // export default —— 具名导入拿不到它，但记下来免得误报
  if (/export\s+default\b/.test(source)) names.add("default");

  return names;
}

describe("模块解析 —— 守住两个让主流程跑不起来的 bug", () => {
  it("扫到了足够的文件（扫描器本身没坏）", () => {
    // 少于 40 个说明扫描逻辑出问题了，后面的断言就成了空转
    expect(ALL_MJS.length).toBeGreaterThan(40);
  });

  it("每个相对 import 的目标文件都存在", () => {
    const broken: string[] = [];

    for (const file of ALL_MJS) {
      const source = readFileSync(file, "utf-8");
      for (const specifier of relativeSpecifiers(source)) {
        const target = resolve(dirname(file), specifier);
        if (!existsSync(target)) {
          broken.push(
            `${file.replace(REPO_ROOT + "\\", "").replace(/\//g, "/")} → ${specifier}`,
          );
        }
      }
    }

    expect(
      broken,
      `这些相对 import 指向了不存在的文件：\n  ${broken.join("\n  ")}`,
    ).toEqual([]);
  });

  it("每个具名 import 的名字都真的被导出了", () => {
    const broken: string[] = [];

    for (const file of ALL_MJS) {
      const source = readFileSync(file, "utf-8");
      for (const { names, specifier } of namedImports(source)) {
        const target = resolve(dirname(file), specifier);
        if (!existsSync(target)) continue; // 上一条已经报了

        const exported = staticExportNames(target);
        for (const name of names) {
          if (!exported.has(name)) {
            broken.push(
              `${file.replace(REPO_ROOT + "\\", "").replace(/\//g, "/")} → ` +
                `${specifier} 没有导出 "${name}"`,
            );
          }
        }
      }
    }

    expect(
      broken,
      `这些具名 import 找不到对应导出：\n  ${broken.join("\n  ")}`,
    ).toEqual([]);
  });

  it("没有 export *（否则上面的静态检查会漏判）", () => {
    const offenders: string[] = [];
    for (const file of ALL_MJS) {
      const source = readFileSync(file, "utf-8");
      if (/export\s+\*/.test(source)) {
        offenders.push(file.replace(REPO_ROOT + "\\", "").replace(/\//g, "/"));
      }
    }
    expect(
      offenders,
      "出现 export * 后，具名导出的静态检查就不准了 —— 要先支持再放开",
    ).toEqual([]);
  });
});

/**
 * 入口脚本真的能起来 —— 比静态检查更硬的一层。
 *
 * 静态检查只看「谁 import 了谁」，但入口脚本能不能跑通还取决于
 * 整条 import 链（ESM 在**加载**时就要求所有具名导出都存在）。
 *
 * 做法：跑子进程、**不给参数**。
 * 这些脚本没参数时会打印 Usage 然后退出 —— 不会真去生成世界，
 * 但 import 链已经整条走了一遍。
 *
 * 断言的是「看到 Usage」而不是「没报错」——
 * 因为 SyntaxError 和 MODULE_NOT_FOUND 也会导致「没看到 Usage」。
 */
describe("入口脚本能启动", () => {
  const ENTRY_POINTS = [
    { path: "orchestrator/src/index.mjs", label: "创建世界" },
    { path: "generators/map/src/index.mjs", label: "生成地图" },
    { path: "generators/character/src/index.mjs", label: "生成角色" },
  ];

  for (const entry of ENTRY_POINTS) {
    it(`${entry.label}（${entry.path}）能加载并打印 Usage`, () => {
      const scriptPath = join(REPO_ROOT, entry.path);
      let output = "";
      let failed = false;

      try {
        output = execFileSync(process.execPath, [scriptPath], {
          cwd: REPO_ROOT,
          encoding: "utf-8",
          timeout: 30_000,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err: any) {
        // 非 0 退出码也要看输出 —— 有的脚本是「打印 Usage 后 exit(1)」
        output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
        failed = true;
      }

      // 出现这两种，说明 import 链断了
      expect(output, `${entry.path} 的 import 链断了`).not.toMatch(
        /does not provide an export named/,
      );
      expect(output, `${entry.path} 的 import 链断了`).not.toMatch(
        /ERR_MODULE_NOT_FOUND/,
      );
      expect(output, `${entry.path} 应该打印 Usage`).toMatch(/Usage:/);

      // Usage 说明参数检查过了 —— 脚本真的加载到能跑逻辑的那一步
      if (failed) {
        expect(output).toMatch(/Usage:/);
      }
    });
  }
});
