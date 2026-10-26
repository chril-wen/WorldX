/**
 * `own-world characters` —— 列出角色和他们在干什么。
 *
 * 需要 server —— 角色的**当前状态**存在 server 的 SQLite 里。
 */

import { apiOrThrow, isServerUp } from "../lib/api-client.mjs";
import { emit, section } from "../lib/format.mjs";

/**
 * 列出角色。
 *
 * @param {object} ctx
 */
export async function cmdCharacters({ flags }) {
  const asJson = flags.has("json");

  if (!(await isServerUp())) {
    throw new Error(
      "server 没在跑。角色的当前状态在它数据库里。\n先启动：npm run dev:server",
    );
  }

  const characters = await apiOrThrow("GET", "/api/characters");
  const data = { characters };

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
          const where = c.mainAreaPointId
            ? `${c.location} @ ${c.mainAreaPointId}`
            : (c.location ?? "？");
          console.log(`  ${c.name}${c.role ? `（${c.role}）` : ""}`);
          console.log(`    位置：${where}`);
          console.log(`    情绪：${c.emotion ?? "?"}`);
          console.log(`    正在：${c.currentActionLabel ?? c.currentAction ?? "闲置"}`);
          console.log("");
        }
      });
    },
  });
}
