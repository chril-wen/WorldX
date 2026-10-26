/**
 * `own-world tick` —— 推进一个 tick。
 *
 * ## 为什么要先查 worldId / timelineId
 *
 * `/api/simulation/tick` 要求请求体带 `worldId` 和 `timelineId`，
 * server 会校验「跟你要推进的是同一个世界」——
 * 防的是**在别的世界上推进**（比如你切了世界但客户端还拿着旧 id）。
 *
 * 校验不过返回 400/503。所以 CLI 得先问 server「现在跑的是哪个世界、
 * 哪条时间线」，再带着这两个值去 tick。
 *
 * ## 不传 --world 的行为
 *
 * 用 server 当前的上下文。CLI **不切世界** —— 切世界是
 * `own-world use <worldId>` 的事，隐式切世界会让「我现在在哪个世界」
 * 这件事变得不可预测。
 */

import { api, apiOrThrow, isServerUp } from "../lib/api-client.mjs";
import { emit, printRows, section } from "../lib/format.mjs";
import { renderEvents } from "../lib/event-render.mjs";
import { buildNameMaps } from "../lib/name-maps.mjs";
import { buildDisplaySection } from "../lib/display-json.mjs";

/**
 * 推进一个（或多个）tick。
 *
 * @param {object} ctx
 * @param {object} ctx.options
 * @param {object} ctx.flags
 */
export async function cmdTick({ options, flags }) {
  const asJson = flags.has("json");
  const count = Math.max(1, Number(options.count ?? 1) || 1);

  if (!(await isServerUp())) {
    throw new Error(
      "server 没在跑。tick 需要 server（模拟状态在它内存里）。\n" +
        "先启动：npm run dev:server",
    );
  }

  // 1. 先问 server 当前的上下文
  const worlds = await apiOrThrow("GET", "/api/world/worlds");
  const worldId = options.world ?? worlds.currentWorldId;
  if (!worldId) {
    throw new Error(
      "server 当前没有加载任何世界。先生成一个：npm run create \"……\"",
    );
  }

  // 时间线 id 来自 `/api/world/worlds` 的 `currentTimelineId`
  // （`/api/simulation/status` 不带这个字段）。
  const timelineId = worlds.currentTimelineId;
  if (!timelineId) {
    throw new Error("server 当前没有活动的时间线。先跑一次 tick 或建一条时间线。");
  }

  // 2. 推进
  const results = [];
  for (let i = 0; i < count; i++) {
    const result = await apiOrThrow("POST", "/api/simulation/tick", { worldId, timelineId });
    results.push(result);
  }

  const last = results[results.length - 1];
  const data = {
    worldId,
    timelineId,
    ticks: count,
    gameTime: last.gameTime,
    events: results.flatMap((r) => r.events ?? []),
    eventCount: last.eventCount,
  };

  // 事件里的人话摘要 —— 名字从世界配置读，不依赖 server
  //
  // ⚠ 用 **server 告诉我们的 worldId**，不是 `options.world`。
  //
  // 之前这里传 `null`（意思是「选 mtime 最新的世界」），而 server
  // 跑的世界未必是 mtime 最新的 —— server 跑的时候会写文件，mtime 会变。
  // 结果：tick 的是 A 世界的模拟，名字却从 B 世界读，显示成裸 id。
  //
  // 显式传了 `--world` 但跟 server 当前的不一致时，server 会拒绝
  // 这次 tick（400），所以走到这里两者必然一致 —— 用 worldId 是对的。
  const names = buildNameMaps(worldId);
  const rendered = await renderEvents(data.events, names.characterNames, names.locationNames);

  // `--json` 时额外给一段人话 —— 原始事件一个不少，
  // 脚本要「林哲」「主区域」用 `display`，要原始数据用 `events`。
  const dataWithDisplay = {
    ...data,
    display: buildDisplaySection({ events: data.events, rendered, names }),
  };

  emit({
    data: dataWithDisplay,
    json: JSON.stringify(dataWithDisplay, null, 2),
    asJson,
    human: () => {
      const t = last.gameTime ?? {};
      section(`推进了 ${count} 个 tick`, () => {
        printRows([
          { label: "世界", value: worldId },
          { label: "时间线", value: timelineId },
          { label: "当前时间", value: formatGameTime(t) },
          { label: "事件数", value: String(last.eventCount ?? 0) },
        ]);
      });

      if (rendered.length > 0) {
        section("事件", () => {
          for (const { summary } of rendered) {
            console.log(`  ${summary}`);
          }
        });
      }
    },
  });
}

/**
 * 把 gameTime 格式化成「第N天 HH:mm（早上）」。
 *
 * 字段名来自 core 的 `buildWorldTimeInfo()`：
 * `day` / `tick` / `timeString` / `period`。
 *
 * @param {object} t
 * @returns {string}
 */
export function formatGameTime(t) {
  if (!t) return "(未知)";
  const day = t.day ?? 1;
  const clock = t.timeString ?? "";
  const period = t.period ? `（${t.period}）` : "";
  return `第 ${day} 天 ${clock}${period}`.trim();
}
