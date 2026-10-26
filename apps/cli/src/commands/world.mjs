/**
 * `worldx world` —— 看一个世界的详情。
 *
 * 不需要 server —— world.json 就在磁盘上。
 */

import { readWorldConfig, resolveWorldDir, worldIdOf } from "../lib/world-paths.mjs";
import { emit, printRows, section } from "../lib/format.mjs";

/**
 * 看世界详情。
 *
 * @param {object} ctx
 */
export async function cmdWorld({ options, flags }) {
  const asJson = flags.has("json");

  const worldDir = resolveWorldDir(options.world);
  const config = readWorldConfig(worldDir);

  const data = {
    id: worldIdOf(worldDir),
    name: config.worldName,
    description: config.worldDescription,
    socialContext: config.worldSocialContext,
    originalPrompt: config.originalPrompt,
    contentLanguage: config.contentLanguage,
    centerLocationId: config.centerLocationId,
    locations: (config.locations ?? []).map((l) => ({
      id: l.id,
      name: l.name,
      objects: (l.objects ?? []).length,
      adjacent: (l.adjacentLocations ?? []).length,
    })),
    mainAreaPointCount: (config.mainAreaPoints ?? []).length,
    worldSize: config.worldSize,
    scene: config.scene,
    dir: worldDir,
  };

  emit({
    data,
    json: JSON.stringify(data, null, 2),
    asJson,
    human: () => {
      section("世界", () => {
        printRows([
          { label: "id", value: data.id },
          { label: "名字", value: data.name ?? "?" },
          { label: "语言", value: data.contentLanguage ?? "?" },
          { label: "中心区域", value: data.centerLocationId ?? "main_area" },
          { label: "地点数", value: String(data.locations.length) },
          { label: "主区域点位", value: String(data.mainAreaPointCount) },
        ]);
      });

      if (data.description) {
        section("描述", () => {
          console.log(`  ${data.description}`);
        });
      }

      if (data.originalPrompt) {
        section("最初的那句话", () => {
          console.log(`  ${data.originalPrompt}`);
        });
      }

      if (data.worldSize) {
        section("地图尺寸", () => {
          printRows([
            { label: "像素", value: `${data.worldSize.width} × ${data.worldSize.height}` },
            { label: "格子", value: `${data.worldSize.gridWidth} × ${data.worldSize.gridHeight}` },
            { label: "每格", value: `${data.worldSize.tileSize} px` },
          ]);
        });
      }
    },
  });
}
