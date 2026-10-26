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

  // 动作名要**分开取**：
  // - `data.actionName` 是显示名（「找人攀谈」）
  // - `data.action` 可能是内部 id（`post_dialogue`）
  //
  // 混着取会让内部 id 露馅（「赵龙 结束post_dialogue」）。
  const actionText = f.actionLabel(event.data?.action, event.data?.actionName) || "";
  const summary = f.extractEventSummary(event.data);

  switch (event.type) {
    case "dialogue": {
      const turns = event.data?.turns ?? [];

      // **整段对话**和**单轮**是两个不同的事件，渲染方式也不同。
      //
      // core 在 `simulation-engine.ts` 里发两种 dialogue 事件：
      // - `phase: "turn"` —— 一轮，一个 speaker 说一句
      // - `phase: "complete"` —— 整段对话结束，`turns` 是**全部**轮次
      //
      // 之前两种都取 `turns[turns.length - 1]` —— 对 "complete" 来说
      // 那就是最后一句。于是「整段对话」事件和「最后一句」事件
      // 渲染出**同一行**，同一次对话显示两遍。
      //
      // 整段对话应该显示成多行 —— 那是它的价值所在。
      if (event.data?.phase === "complete") {
        if (turns.length === 0) {
          const who = actor && target ? `${actor} → ${target}` : (actor || target);
          return `${who} 结束对话`;
        }
        const lines = turns.map((t) => {
          const speaker = nameMap.get(t.speaker) ?? f.prettifyToken(t.speaker ?? "");
          return `${speaker}：「${t.content}」`;
        });
        // 多行 —— 调用方按 \n 拆
        return lines.join("\n  ");
      }

      const preview = turns[turns.length - 1]?.content;
      const who = actor && target ? `${actor} → ${target}` : (actor || target);
      if (preview) return `${who}：「${preview}」`;
      return `${who} 对话${turns.length ? `（${turns.length} 句）` : ""}`;
    }
    case "action_start":
      return `${actor || "某人"} 在${location} ${actionText || "开始行动"}`;
    case "action_end":
      return `${actor || "某人"} 结束${actionText || "行动"}`;
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
      return summary ?? (actor ? `${actor}：${actionText || "（无描述）"}` : (actionText || "（无描述）"));
  }
}

/**
 * 渲染一批事件。
 *
 * ## 为什么要一起去重对话
 *
 * core 发两种 dialogue 事件：
 * - `phase: "turn"` —— 一轮，一个 speaker 说一句
 * - `phase: "complete"` —— 整段对话结束，`turns` 是**全部**轮次
 *
 * 两者描述的是**同一段对话**。都渲染的话，一次对话会显示两遍
 * （turn 版一行一句 + complete 版整段）。
 *
 * core 自己的 `perceiver.ts` 就是**只取 complete** 的 —— 那是权威版本。
 *
 * 所以这里也这么做：**一段对话有 complete 事件时，跳过它的 turn 事件**。
 * 没有 complete（对话还没结束）时才显示 turn 事件 —— 那时它是唯一的信息源。
 *
 * ## 返回值为什么是 `{ event, summary }` 而不是字符串数组
 *
 * 跳过 turn 事件后，摘要数组和事件数组**长度不再一致** ——
 * 调用方要是还用 `summaries[i]` 对应 `events[i]`，就会**错位**
 * （时间标注贴到别的行上）。
 *
 * 把事件和摘要**绑在一起**返回，调用方就不可能错位。
 *
 * @param {object[]} events
 * @param {Map<string, string>} nameMap
 * @param {Map<string, string>} locationMap
 * @returns {Promise<Array<{event: object, summary: string}>>}
 */
export async function renderEvents(events, nameMap, locationMap) {
  // 有 complete 事件的对话 id —— 这些对话只显示 complete
  const completedConversations = new Set(
    events
      .filter((e) => e.type === "dialogue" && e.data?.phase === "complete")
      .map((e) => e.data?.conversationId)
      .filter(Boolean),
  );

  const out = [];
  for (const e of events) {
    if (e.type === "dialogue" && e.data?.phase === "turn") {
      const convId = e.data?.conversationId;
      if (convId && completedConversations.has(convId)) continue; // 有 complete，跳过
    }
    out.push({ event: e, summary: await renderEvent(e, nameMap, locationMap) });
  }
  return out;
}
