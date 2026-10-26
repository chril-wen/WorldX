/**
 * 世界目录寻址 —— CLI 和脚本共用的**唯一一份**。
 *
 * ## 为什么抽出来
 *
 * 改造前 `scripts/rules.mjs` 和 `scripts/timeline.mjs` 各自写了一份
 * 「找世界目录」的逻辑 —— 同样的 `listWorldDirs` / `resolveWorldDir`，
 * 连注释都是同一句「最近的生成世界优先」。
 *
 * 两份实现已经**开始漂移**了：`rules.mjs` 支持 `--world` 传路径
 * （测试世界常在仓库外的临时目录里），`timeline.mjs` 不支持 ——
 * 它只认世界 id。所以同一个 `--world` 参数在两个 CLI 里行为不同。
 *
 * 现在只有这一份。谁要改世界寻址的语义，改这里。
 *
 * ## 「当前世界」是什么
 *
 * `output/worlds/` 下 **mtime 最新**的那个。
 * `output/` 优先于 `library/` —— 生成的世界是「正在玩的」，
 * `library/` 是手动放进来的备选。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 仓库根 —— 从 `apps/cli/src/lib/` 往上四层。 */
export const PROJECT_DIR = path.resolve(__dirname, "..", "..", "..", "..");

/** 生成的世界（可以随时删）。 */
export const GENERATED_WORLDS_DIR = path.join(PROJECT_DIR, "output", "worlds");

/** 保留的世界（进版本管理）。 */
export const LIBRARY_WORLDS_DIR = path.join(PROJECT_DIR, "library", "worlds");

/**
 * 列出所有世界的目录。
 *
 * @param {(worldDir: string) => boolean} [isWorld]
 *   额外的判定条件。默认是「有 world.json」。
 *   `timeline.mjs` 用的是「有 `timelines/` 目录」—— 因为它操作的是
 *   时间线，一个还没跑过模拟的世界对它没有意义。
 *
 * @returns {string[]} 世界目录绝对路径
 */
export function listWorldDirs(isWorld) {
  const predicate = isWorld ?? hasWorldJson;
  const out = [];
  for (const base of [GENERATED_WORLDS_DIR, LIBRARY_WORLDS_DIR]) {
    if (!fs.existsSync(base)) continue;
    for (const name of fs.readdirSync(base)) {
      const dir = path.join(base, name);
      if (!fs.statSync(dir).isDirectory()) continue;
      if (predicate(dir)) out.push(dir);
    }
  }
  return out;
}

/**
 * 目录里有没有 `timelines/` —— 时间线工具的判据。
 *
 * @param {string} worldDir
 * @returns {boolean}
 */
export function hasTimelines(worldDir) {
  return fs.existsSync(path.join(worldDir, "timelines"));
}

/**
 * 目录里有没有 world.json。
 *
 * 两种布局都认：世界根下的 `world.json`（旧布局）
 * 和 `config/world.json`（现在的布局）。
 */
export function hasWorldJson(worldDir) {
  return (
    fs.existsSync(path.join(worldDir, "world.json")) ||
    fs.existsSync(path.join(worldDir, "config", "world.json"))
  );
}

/**
 * 找到世界目录。
 *
 * `worldId` 可以是：
 * - **世界 id** —— `output/worlds/` 里的目录名
 * - **路径** —— 绝对路径，或相对仓库根的路径
 *   （测试世界常在仓库外的临时目录里，必须支持）
 * - **不给** —— 用「当前世界」= 最近生成的那个
 *
 * @param {string|null|undefined} worldId
 * @param {(worldDir: string) => boolean} [isWorld]
 *   世界判据。默认「有 world.json」。时间线工具用「有 timelines/ 目录」。
 * @returns {string} 世界目录绝对路径
 */
export function resolveWorldDir(worldId, isWorld) {
  const predicate = isWorld ?? hasWorldJson;

  if (worldId) {
    // 先当路径试
    const asPath = path.resolve(PROJECT_DIR, worldId);
    if (fs.existsSync(asPath) && fs.statSync(asPath).isDirectory() && predicate(asPath)) {
      return asPath;
    }
    // 再当世界 id 找
    const dirs = listWorldDirs(predicate);
    const found = dirs.find((d) => path.basename(d) === worldId);
    if (!found) throw new Error(`找不到世界：${worldId}`);
    return found;
  }

  const dirs = listWorldDirs(predicate);
  if (dirs.length === 0) throw new Error("没有任何世界");

  // 最近的生成世界优先
  const generated = dirs.filter((d) => d.startsWith(GENERATED_WORLDS_DIR));
  const pool = generated.length > 0 ? generated : dirs;
  pool.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return pool[0];
}

/**
 * world.json 的路径 —— 两种布局都认。
 *
 * @param {string} worldDir
 * @returns {string} world.json 绝对路径
 */
export function worldJsonPath(worldDir) {
  const candidates = [
    path.join(worldDir, "config", "world.json"),
    path.join(worldDir, "world.json"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`${worldDir} 里没有 world.json`);
}

/**
 * 读 world.json。
 *
 * @param {string} worldDir
 * @returns {object} world.json 的内容
 */
export function readWorldConfig(worldDir) {
  return JSON.parse(fs.readFileSync(worldJsonPath(worldDir), "utf-8"));
}

/**
 * 世界的短名（目录名）—— 日志和输出里用。
 *
 * @param {string} worldDir
 * @returns {string}
 */
export function worldIdOf(worldDir) {
  return path.basename(worldDir);
}
