/**
 * `worldx locations` —— 列出世界的地点。
 *
 * 不需要 server。
 *
 * ## 为什么要单独一条命令
 *
 * 阶段 5 修掉的那个 bug 就是「TMJ 里有、world.json 里没有」的区域 ——
 * 客户端画得出框，服务端不认识。
 *
 * 所以这条命令顺便做一件有用的事：**对比 TMJ 和 world.json 的地点 id**，
 * 不一致就报出来。这不是「加功能」，是把已经修过的坑做成**可观测**的 ——
 * 下次再出现时不用重新查一遍。
 */

import fs from "node:fs";
import path from "node:path";
import { resolveWorldDir, readWorldConfig, worldIdOf } from "../lib/world-paths.mjs";
import { emit, printRows, section } from "../lib/format.mjs";

/**
 * 从 TMJ 里读区域 id。
 *
 * @param {string} worldDir
 * @returns {string[]} 区域 id
 */
function readTmjRegionIds(worldDir) {
  const tmjPath = path.join(worldDir, "map", "06-final.tmj");
  if (!fs.existsSync(tmjPath)) return [];

  try {
    const tmj = JSON.parse(fs.readFileSync(tmjPath, "utf-8"));
    const layers = Array.isArray(tmj?.layers) ? tmj.layers : [];
    const regions = layers.find((l) => l?.name === "regions");
    const objects = Array.isArray(regions?.objects) ? regions.objects : [];

    return objects
      .map((obj) => {
        const props = Array.isArray(obj?.properties) ? obj.properties : [];
        const idProp = props.find((p) => p?.name === "id");
        return typeof idProp?.value === "string" ? idProp.value : null;
      })
      .filter((id) => id !== null);
  } catch {
    // TMJ 坏了不该让这条命令整体失败 —— 至少 world.json 那边还能看
    return [];
  }
}

/**
 * 列出地点。
 *
 * @param {object} ctx
 */
export async function cmdLocations({ options, flags }) {
  const asJson = flags.has("json");

  const worldDir = resolveWorldDir(options.world);
  const config = readWorldConfig(worldDir);
  const locations = config.locations ?? [];

  const tmjRegionIds = readTmjRegionIds(worldDir);
  const worldIds = locations.map((l) => l.id);
  const centerId = config.centerLocationId ?? "main_area";

  // 两边对不上的
  //
  // ⚠ **中心区域是合法的例外** —— 它由 mainAreaPoints（一批点位）定义，
  // 不是由一个矩形定义，所以 TMJ 里**本来就没有**它的 region。
  // `repair-world-locations.mjs` 的规则 3 明确允许这一点。
  //
  // 把它算成「不一致」是误报 —— 阶段 5 修的那个真 bug 是**别的**区域
  // （非中心区域）只在 TMJ 里、不在 world.json 里。
  const onlyInTmj = tmjRegionIds.filter((id) => !worldIds.includes(id));
  const onlyInWorld = worldIds.filter((id) => !tmjRegionIds.includes(id) && id !== centerId);

  const data = {
    worldId: worldIdOf(worldDir),
    centerLocationId: centerId,
    locations: locations.map((l) => ({
      id: l.id,
      name: l.name,
      description: l.description,
      objects: (l.objects ?? []).length,
      adjacent: l.adjacentLocations ?? [],
      isCenter: l.id === centerId,
    })),
    divergence: { onlyInTmj, onlyInWorld },
  };

  emit({
    data,
    json: JSON.stringify(data, null, 2),
    asJson,
    human: () => {
      section(`地点（${locations.length}）`, () => {
        for (const l of data.locations) {
          const center = l.isCenter ? "  ← 中心区域" : "";
          console.log(`  ${l.name}（${l.id}）${center}`);
          console.log(`    物件 ${l.objects} 个，邻接 ${l.adjacent.length} 个`);
        }
      });

      // 一致性检查 —— 阶段 5 修的那个坑
      if (onlyInTmj.length > 0 || onlyInWorld.length > 0) {
        section("⚠ 地点来源不一致", () => {
          if (onlyInTmj.length > 0) {
            console.log(`  只在 TMJ 里（客户端画得出、服务端不认识）：`);
            for (const id of onlyInTmj) console.log(`    ${id}`);
          }
          if (onlyInWorld.length > 0) {
            console.log(`  只在 world.json 里（服务端认识、客户端画不出）：`);
            for (const id of onlyInWorld) console.log(`    ${id}`);
          }
          console.log("\n  修：node orchestrator/src/repair-world-locations.mjs --world <id>");
        });
      } else if (tmjRegionIds.length > 0) {
        section("一致性检查", () => {
          // 中心区域在 TMJ 里没有 region 是**设计如此** ——
          // 它由 mainAreaPoints 定义，不是矩形。所以数字会差 1。
          const centerInTmj = tmjRegionIds.includes(centerId);
          const expectedDiff = centerInTmj ? 0 : 1;
          const actualDiff = worldIds.length - tmjRegionIds.length;

          if (actualDiff === expectedDiff) {
            const note = expectedDiff === 1 ? "（中心区域例外）" : "";
            console.log(
              `  ✓ TMJ（${tmjRegionIds.length}）与 world.json（${worldIds.length}）一致${note}`,
            );
          } else {
            console.log(
              `  ? TMJ（${tmjRegionIds.length}）与 world.json（${worldIds.length}）数量差 ${actualDiff}` +
                `（预期 ${expectedDiff}）`,
            );
          }
        });
      }
    },
  });
}
