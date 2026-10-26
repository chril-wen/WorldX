/**
 * `own-world events` —— 看事件流。
 *
 * 需要 server —— 事件存在 server 的 SQLite 里。
 *
 * 支持过滤：
 * ```
 * own-world events --limit 20
 * own-world events --type dialogue
 * own-world events --actor char_xxx
 * own-world events --from-day 2 --to-day 3
 * ```
 */

import { apiOrThrow, isServerUp } from "../lib/api-client.mjs";
import { emit, section } from "../lib/format.mjs";
import { renderEvents } from "../lib/event-render.mjs";
import { buildNameMaps } from "../lib/name-maps.mjs";

/**
 * 看事件。
 *
 * @param {object} ctx
 */
export async function cmdEvents({ options, flags }) {
  const asJson = flags.has("json");

  if (!(await isServerUp())) {
    throw new Error(
      "server 没在跑。事件在它数据库里。\n先启动：npm run dev:server",
    );
  }

  const query = new URLSearchParams();
  if (options.limit) query.set("limit", String(options.limit));
  if (options.type) query.set("type", String(options.type));
  if (options.actor) query.set("actorId", String(options.actor));
  if (options["from-day"]) query.set("fromDay", String(options["from-day"]));
  if (options["to-day"]) query.set("toDay", String(options["to-day"]));

  const events = await apiOrThrow("GET", `/api/events?${query.toString()}`);
  const data = { events };

  // 名字表要跟事件来自**同一个世界**。
  //
  // 之前用 `options.world`（没传就是 null = 「选 mtime 最新的世界」）——
  // 但 server 跑的世界未必是 mtime 最新的（server 跑的时候会写文件），
  // 结果事件来自 A 世界、名字从 B 世界读，显示成裸 id。
  //
  // `/api/events` 不带 worldId（它按 server 当前上下文查），
  // 所以这里要另外问一次 server「现在是哪个世界」。
  const worlds = await apiOrThrow("GET", "/api/world/worlds");
  const worldId = options.world ?? worlds.currentWorldId ?? null;
  const { characterNames, locationNames } = buildNameMaps(worldId);
  const summaries = await renderEvents(events, characterNames, locationNames);

  emit({
    data,
    json: JSON.stringify(data, null, 2),
    asJson,
    human: () => {
      if (events.length === 0) {
        console.log("没有匹配的事件。");
        return;
      }
      // 计数用**渲染出的事件条数** —— 整段对话会替掉它的单轮事件，
      // 所以显示条数比原始事件数少，显示原始数会让人以为少了内容。
      //
      // （注意不是行数 —— 整段对话会展开成多行。）
      section(`事件（${summaries.length}）`, () => {
        for (const { event: e, summary } of summaries) {
          const when = e.gameDay != null ? `第${e.gameDay}天` : "";
          console.log(`  ${when}  ${summary}`);
        }
      });
    },
  });
}
