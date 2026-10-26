/**
 * JSON 输出里的「人话」段。
 *
 * ## 为什么加这个而不改 `events`
 *
 * `own-world tick --json` / `own-world events --json` 给的是**原始事件**：
 *
 * ```json
 * { "actorId": "char_1792860348082", "location": "main_area", ... }
 * ```
 *
 * 脚本要「林哲」「主区域」得自己去读 `config/world.json` 查映射。
 *
 * 但改成替换原始字段是**坏主意**：
 *
 * - 脚本可能存进数据库 —— 那要的是完整原始数据
 * - 显示层改一次（比如加个动作名），存进去的数据就跟着变
 *
 * 所以**加字段，不替换**：
 *
 * ```json
 * {
 *   "events": [ ...原始事件... ],
 *   "display": {
 *     "characterNames": { "char_1792860348082": "林哲" },
 *     "locationNames": { "main_area": "主区域" },
 *     "actionNames": { "stroll_and_observe": "闲逛观察" },
 *     "summaries": [ { "eventId": "...", "summary": "林哲 → 宋福：「…」" } ]
 *   }
 * }
 * ```
 *
 * 要原始数据用 `events`，要人话用 `display` —— 两边都不破。
 *
 * ## 为什么给**映射表**而不只是当次用到的名字
 *
 * 脚本可能要处理**别的**事件（不只是这次返回的）。
 * 给了映射表，脚本能自己翻译任意 id。
 */

import { toDisplaySummaries } from "./event-render.mjs";

/**
 * 构造 `display` 段。
 *
 * @param {object} opts
 * @param {object[]} opts.events 原始事件
 * @param {Array<{event: object, summary: string}>} opts.rendered renderEvents 的结果
 * @param {object} opts.names 名字映射（Map）
 * @returns {object} display 段
 */
export function buildDisplaySection({ events, rendered, names }) {
  return {
    // 映射表给全量，不只是这次用到的
    characterNames: Object.fromEntries(names.characterNames),
    locationNames: Object.fromEntries(names.locationNames),
    actionNames: Object.fromEntries(names.actionNames),
    pointNames: Object.fromEntries(names.pointNames),
    // 人话摘要 —— 每条带 eventId，好跟 events 数组关联
    summaries: toDisplaySummaries(rendered),
  };
}
