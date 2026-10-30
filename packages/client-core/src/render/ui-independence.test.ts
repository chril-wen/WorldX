/**
 * 「面板层不依赖 Phaser」的单测。
 *
 * ## 为什么这个要测
 *
 * 8.3 的核心目标之一：把 UI 层从渲染引擎上解绑。
 *
 * 面板层（8000+ 行 React）本来只为了**一个类型标注**就 import Phaser：
 *
 * ```
 * client/src/ui/App.tsx
 *   import Phaser from "phaser";
 *   export function App({ eventBus }: { eventBus: Phaser.Events.EventEmitter }) {
 * ```
 *
 * 一个只为了传消息的依赖，把整个 UI 绑在了渲染引擎上 ——
 * 8.4 下线旧 Phaser 层时，UI 会跟着一起编译不过。
 *
 * ## 为什么用「读文件」而不是「import 进来测」
 *
 * 因为要测的**恰恰是 import 本身**。
 * 真的 import 一次，就等于把它变成**运行时依赖** ——
 * 那这个测试自己就破坏了它要守的东西。
 *
 * 所以读源码文本，查 import 语句。
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** UI 层源码目录。 */
const UI_DIR = join(process.cwd(), "client", "src", "ui");

/** 递归列出目录下的所有 `.ts` / `.tsx` 文件。 */
function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (full.endsWith(".ts") || full.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 抽出文件里的 **import 语句**（不含注释里的）。
 *
 * ## 为什么要排除注释
 *
 * `App.tsx` 和 `GodPanel.tsx` 的**注释里**提到 Phaser
 * （「Phaser keeps running but is visually muted」这类说明）——
 * 那是给人看的，不是依赖。
 *
 * 验收标准说的是「不 import」，注释里提一句不构成依赖。
 */
function extractImports(source: string): string[] {
  // 先把行注释和块注释去掉，剩下的才是真代码。
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  return withoutComments
    .split("\n")
    .filter((line) => /^\s*import\b/.test(line) || /\bfrom\s+["']/.test(line))
    .map((line) => line.trim());
}

describe("面板层不依赖 Phaser", () => {
  const files = listSourceFiles(UI_DIR);

  it("UI 层确实有源文件（防空跑）", () => {
    // 判据不能是「没找到违规」—— 那可能是根本没扫到文件。
    expect(files.length).toBeGreaterThan(10);
  });

  it("没有任何文件 import Phaser", () => {
    const violations: string[] = [];
    for (const file of files) {
      for (const stmt of extractImports(readFileSync(file, "utf-8"))) {
        if (/\bfrom\s+["']phaser["']/.test(stmt) || /["']phaser["']/.test(stmt)) {
          violations.push(`${file.replace(process.cwd(), "")}: ${stmt}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("UI 层不 import 任何渲染引擎的东西", () => {
    // 不只是 Phaser —— 面板层不该依赖**任何**渲染引擎。
    const engines = ["phaser", "three", "pixi.js", "konva"];
    const violations: string[] = [];
    for (const file of files) {
      for (const stmt of extractImports(readFileSync(file, "utf-8"))) {
        for (const engine of engines) {
          if (new RegExp(`["']${engine.replace(".", "\\.")}["']`).test(stmt)) {
            violations.push(`${file.replace(process.cwd(), "")}: ${stmt}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
