/**
 * `own-world characters` —— 列出角色和他们在干什么。
 *
 * 需要 server —— 角色的**当前状态**存在 server 的 SQLite 里。
 */

import { apiOrThrow, isServerUp } from "../lib/api-client.mjs";
import { emit, section } from "../lib/format.mjs";
import { buildNameMaps } from "../lib/name-maps.mjs";
import { loadEventFormat } from "../lib/core-loader.mjs";

/**
 * 列出角色。
 *
 * @param {object} ctx
 */
export async function cmdCharacters({ flags, options }) {
  const asJson = flags.has("json");

  if (!(await isServerUp())) {
    throw new Error(
      "server 没在跑。角色的当前状态在它数据库里。\n先启动：npm run dev:server",
    );
  }

  const characters = await apiOrThrow("GET", "/api/characters");
  const data = { characters };

  // 状态里的地点 / 动作 / 点位都是**内部 id**：
  // `main_area`、`stroll_and_observe`、`main_area_point_17`。
  //
  // 不查世界配置就只能显示裸 id —— 而 `tick` / `events` 查了。
  // 同一个 CLI 里两套显示标准是不能接受的。
  //
  // 名字从世界配置读（不依赖 server 额外接口）。
  const worlds = await apiOrThrow("GET", "/api/world/worlds");
  const worldId = options.world ?? worlds.currentWorldId ?? null;
  const { locationNames, actionNames, pointNames } = buildNameMaps(worldId);

  // 引擎内部的 action（`in_conversation`）不在 world.json 的
  // `worldActions` 里 —— 查 core 的表（跟 CLI 其他地方同一份）。
  const { actionLabel } = await loadEventFormat();

  emit({
    data,
    json: JSON.stringify(data, null, 2),
    asJson,
    human: () => {
      if (characters.length === 0) {
        console.log("这个世界还没有角色。");
        return;
      }

      section(`角色（${characters.length}）`, () => {
        for (const c of characters) {
          const location = locationNames.get(c.location) ?? c.location;
          const point = c.mainAreaPointId
            ? (pointNames.get(c.mainAreaPointId) ?? c.mainAreaPointId)
            : null;
          const where = point ? `${location} @ ${point}` : (location ?? "？");
          // 动作名：世界动作查 world.json，内部 action 查 core 的表
          // （`actionLabel` 找不到时返回空串，不是 null ——
          //   所以不能用 `??` 兜，得显式判空。）
          const action =
            c.currentActionLabel ||
            actionNames.get(c.currentAction) ||
            actionLabel(c.currentAction, null) ||
            c.currentAction ||
            "闲置";
          console.log(`  ${c.name}${c.role ? `（${c.role}）` : ""}`);
          console.log(`    位置：${where}`);
          console.log(`    情绪：${c.emotion ?? "?"}`);
          console.log(`    正在：${action}`);
          console.log("");
        }
      });
    },
  });
}
