/**
 * 拿到 id → 名字的映射。
 *
 * 事件里存的是 id（`char_1792494562655`、`main_area`），
 * 但人要看到的是名字（`沈四娘`、`主区域`）。
 *
 * 名字从**世界配置**里读（不依赖 server）—— 这样
 * `worldx timeline` 之类不碰 server 的命令也能显示人话。
 */

import { readWorldConfig, resolveWorldDir } from "./world-paths.mjs";
import fs from "node:fs";
import path from "node:path";

/**
 * 建角色 id → 名字的映射。
 *
 * @param {string} worldDir
 * @returns {Map<string, string>}
 */
export function buildCharacterNameMap(worldDir) {
  const map = new Map();

  for (const dir of [
    path.join(worldDir, "config", "characters"),
    path.join(worldDir, "characters"),
  ]) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".json") || file === "characters.json") continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
        if (raw?.id && raw?.name) map.set(raw.id, raw.name);
      } catch {
        // 坏文件跳过 —— 名字表不是关键路径
      }
    }
    if (map.size > 0) break;
  }

  return map;
}

/**
 * 建地点 id → 名字的映射。
 *
 * @param {string} worldDir
 * @returns {Map<string, string>}
 */
export function buildLocationNameMap(worldDir) {
  const map = new Map();
  try {
    const config = readWorldConfig(worldDir);
    for (const loc of config.locations ?? []) {
      if (loc?.id) map.set(loc.id, loc.name ?? loc.id);
    }
  } catch {
    // 读不到就空着 —— 渲染会退回 id
  }
  return map;
}

/**
 * 两个映射一起建。
 *
 * @param {string|null} [worldId]
 * @returns {{characterNames: Map<string,string>, locationNames: Map<string,string>, worldDir: string}}
 */
export function buildNameMaps(worldId) {
  const worldDir = resolveWorldDir(worldId);
  return {
    worldDir,
    characterNames: buildCharacterNameMap(worldDir),
    locationNames: buildLocationNameMap(worldDir),
  };
}
