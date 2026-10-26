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

  const { characterNames, locationNames } = buildNameMaps(options.world);
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
      section(`事件（${events.length}）`, () => {
        for (let i = 0; i < events.length; i++) {
          const e = events[i];
          const when = e.gameDay != null ? `第${e.gameDay}天` : "";
          console.log(`  ${when}  ${summaries[i]}`);
        }
      });
    },
  });
}
