/**
 * `worldx worlds` —— 列出所有世界。
 *
 * ## 为什么直接读文件，不走 server
 *
 * 世界目录就在磁盘上（`output/worlds/` 和 `library/worlds/`）。
 * 走 HTTP 的话，server 没启动就看不了 —— 但「有哪些世界」
 * 是纯文件系统的事，不该依赖进程在不在。
 *
 * 这也是整个 CLI 的分工原则：
 *
 * | 命令 | 要 server 吗 |
 * |---|---|
 * | `worlds` / `world` / `locations` / `rules` / `timeline` | ❌ |
 * | `tick` / `status` / `characters` / `events` | ✅ |
 */

import fs from "node:fs";
import path from "node:path";
import {
  GENERATED_WORLDS_DIR,
  LIBRARY_WORLDS_DIR,
  listWorldDirs,
  readWorldConfig,
  worldIdOf,
} from "../lib/world-paths.mjs";
import { emit, printRows, section } from "../lib/format.mjs";

/**
 * 一个世界的摘要信息。
 *
 * @param {string} worldDir
 * @param {string} source "generated" | "library"
 * @returns {object}
 */
function describeWorld(worldDir, source) {
  let config = {};
  try {
    config = readWorldConfig(worldDir);
  } catch {
    // 坏文件不算致命 —— 列表还是要出得来
  }

  const timelinesDir = path.join(worldDir, "timelines");
  const timelineCount = fs.existsSync(timelinesDir)
    ? fs.readdirSync(timelinesDir).filter((n) =>
        fs.existsSync(path.join(timelinesDir, n, "meta.json")),
      ).length
    : 0;

  return {
    id: worldIdOf(worldDir),
    name: config.worldName ?? "(读不出名字)",
    source,
    locations: Array.isArray(config.locations) ? config.locations.length : 0,
    characters: countCharacters(worldDir),
    timelineCount,
    dir: worldDir,
  };
}

/**
 * 数角色。
 *
 * 角色配置在 `config/characters/*.json`（每个角色一个文件）——
 * **不是** `characters/` 目录，那里面是立绘（每个角色一个子目录）
 * 加一份 `characters.json` 摘要清单。
 *
 * 两种布局都认（老的角色配置直接放在 `characters/` 下）。
 *
 * @param {string} worldDir
 * @returns {number}
 */
function countCharacters(worldDir) {
  for (const dir of [
    path.join(worldDir, "config", "characters"),
    path.join(worldDir, "characters"),
  ]) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
    // 排除 characters.json（那是摘要清单，不是角色）
    const perCharacter = files.filter((n) => n !== "characters.json");
    if (perCharacter.length > 0) return perCharacter.length;
  }
  return 0;
}

/**
 * 列出所有世界。
 *
 * @param {object} ctx
 * @param {object} ctx.options
 * @param {object} ctx.flags
 */
export async function cmdWorlds({ options, flags }) {
  const asJson = flags.has("json");

  const generated = listWorldDirs().filter((d) => d.startsWith(GENERATED_WORLDS_DIR));
  const library = listWorldDirs().filter((d) => d.startsWith(LIBRARY_WORLDS_DIR));

  const data = {
    worlds: [
      ...generated.map((d) => describeWorld(d, "generated")),
      ...library.map((d) => describeWorld(d, "library")),
    ],
  };

  emit({
    data,
    json: JSON.stringify(data, null, 2),
    asJson,
    human: () => {
      if (data.worlds.length === 0) {
        console.log("还没有任何世界。");
        console.log("生成一个：npm run create \"一个江南水乡的茶馆\"");
        return;
      }

      section("生成的世界", () => {
        if (data.worlds.filter((w) => w.source === "generated").length === 0) {
          console.log("  (没有)");
          return;
        }
        for (const w of data.worlds.filter((x) => x.source === "generated")) {
          printRows([
            { label: w.id, value: w.name },
            { label: "  地点", value: `${w.locations} 个` },
            { label: "  角色", value: `${w.characters} 个` },
            { label: "  时间线", value: `${w.timelineCount} 条` },
          ]);
          console.log("");
        }
      });

      if (data.worlds.some((w) => w.source === "library")) {
        section("library 里的世界", () => {
          for (const w of data.worlds.filter((x) => x.source === "library")) {
            printRows([
              { label: w.id, value: w.name },
              { label: "  地点", value: `${w.locations} 个` },
            ]);
            console.log("");
          }
        });
      }
    },
  });
}
