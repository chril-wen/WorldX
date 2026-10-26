/**
 * 事件渲染 —— CLI 里把事件说成人话。
 *
 * ## 取值路径在 core 里
 *
 * `extractEventActionName()` / `extractEventSummary()` 来自 core ——
 * 跟 client 的 `event-format.ts` 用的是**同一份**。
 *
 * 改造前取值逻辑只在 client 私有，CLI 只能自己再写一遍 ——
 * 两边各挑几个字段，同一个事件在界面和终端里显示得不一样。
 *
 * 这里做的是**展示**（把 id 换成名字、把类型翻成中文），
 * 不是**取值** —— 那部分不重复。
 */

import { loadEventFormat } from "./core-loader.mjs";

let coreFormat;

/**
 * 拿到 core 的事件格式化函数（懒加载 + 缓存）。
 */
async function fmt() {
  if (!coreFormat) coreFormat = await loadEventFormat();
  return coreFormat;
}

/**
 * 渲染一个事件。
 *
 * @param {object} event
 * @param {Map<string, string>} nameMap 角色 id → 名字
 * @param {Map<string, string>} locationMap 地点 id → 名字
 * @returns {Promise<string>} 一行摘要
 */
export async function renderEvent(event, nameMap, locationMap) {
  const f = await fmt();

  const actor = nameMap.get(event.actorId) ?? (event.actorId ? f.prettifyToken(event.actorId) : "");
  const target = nameMap.get(event.targetId) ?? (event.targetId ? f.prettifyToken(event.targetId) : "");
  const location = locationMap.get(event.location) ?? f.prettifyToken(event.location ?? "");

  const action = f.extractEventActionName(event.data) ?? "";
  const summary = f.extractEventSummary(event.data);

  switch (event.type) {
    case "dialogue": {
      const turns = event.data?.turns ?? [];
      const preview = turns[turns.length - 1]?.content;
      const who = actor && target ? `${actor} → ${target}` : (actor || target);
      if (preview) return `${who}：「${preview}」`;
      return `${who} 对话${turns.length ? `（${turns.length} 句）` : ""}`;
    }
    case "action_start":
      return `${actor || "某人"} 在${location} ${action || "开始行动"}`;
    case "action_end":
      return `${actor || "某人"} 结束${action || "行动"}`;
    case "movement": {
      const to = locationMap.get(event.data?.to) ?? f.prettifyToken(event.data?.to ?? "");
      return `${actor || "某人"} 移动到 ${to || location}`;
    }
    case "emotion_shift":
      return `${actor || "某人"} 情绪变化`;
    case "reflection":
      return `${actor || "某人"} 反思`;
    case "memory_formed":
      return `${actor || "某人"} 形成记忆`;
    case "world_state_change":
      return summary ?? `世界状态变化${event.data?.description ? `：${event.data.description}` : ""}`;
    case "event_triggered":
      return summary ?? "事件触发";
    default:
      return summary ?? (actor ? `${actor}：${action || "（无描述）"}` : (action || "（无描述）"));
  }
}

/**
 * 渲染一批事件。
 *
 * @param {object[]} events
 * @param {Map<string, string>} nameMap
 * @param {Map<string, string>} locationMap
 * @returns {Promise<string[]>}
 */
export async function renderEvents(events, nameMap, locationMap) {
  const out = [];
  for (const e of events) {
    out.push(await renderEvent(e, nameMap, locationMap));
  }
  return out;
}
