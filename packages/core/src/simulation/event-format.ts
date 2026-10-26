/**
 * 事件摘要 —— 把一个 `SimulationEvent` 说成人话。
 *
 * ## 为什么在 core 里
 *
 * 改造前这件事只有 client 做了（`client/src/ui/utils/event-format.ts`），
 * CLI 要显示事件流时只能自己再写一份 —— 于是**取值路径会漂移**。
 *
 * 漂移的具体形态：事件的动作名可能放在 `data.actionName`、
 * `data.interactionName`、`data.action`、`data.interactionId`、
 * `data.actionType` 里的**任何一个**。两份实现各挑几个，
 * 结果是同一个事件在界面上和终端里显示得不一样。
 *
 * 所以把「**从哪些字段取值**」这件事收进 core：
 * `extractEventActionName()` 是唯一的答案。
 * client 在它之上加 i18n 翻译，CLI 直接用中文名 ——
 * **取值一份，展示各表**。
 *
 * ## 这个文件是纯的
 *
 * 不依赖 i18n、不依赖 React、不依赖 DOM。
 * 所以 core 的「不碰框架」规则依然成立。
 */

/** 事件里可能带动作名的字段 —— 按优先级排。 */
const ACTION_NAME_FIELDS = [
  "actionName",
  "interactionName",
  "action",
  "interactionId",
  "actionType",
] as const;

/**
 * 取出事件里的动作名。
 *
 * @param {Record<string, any> | undefined} data 事件的 `data` 段
 * @returns {string|null} 动作名，没有就 null
 */
export function extractEventActionName(data: Record<string, any> | undefined): string | null {
  if (!data || typeof data !== "object") return null;

  for (const field of ACTION_NAME_FIELDS) {
    const value = data[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/**
 * 取事件里的摘要文本。
 *
 * 事件的 `data` 里可能直接带一句人话（`summary` / `description`），
 * 也可能只带结构化字段（那就得自己拼）。
 *
 * @param {Record<string, any> | undefined} data
 * @returns {string|null}
 */
export function extractEventSummary(data: Record<string, any> | undefined): string | null {
  if (!data || typeof data !== "object") return null;

  for (const field of ["summary", "description", "title", "name"]) {
    const value = data[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/**
 * 把一个标识符转成能看的样子。
 *
 * `char_1792494562655` → `1792494562655`
 * `pawnshop_interior` → `Pawnshop Interior`
 *
 * @param {string} token
 * @returns {string}
 */
export function prettifyToken(token: string): string {
  return token
    .replace(/^char_/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * 事件类型的中文名。
 *
 * 跟 client 的 i18n key 一一对应 —— 但这里是**硬编码的中文**，
 * 因为 CLI 没有 i18n 运行时。
 *
 * @param {string} type
 * @returns {string}
 */
export function eventTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    dialogue: "对话",
    movement: "移动",
    action_start: "开始行动",
    action_end: "行动结束",
    event_triggered: "事件触发",
    emotion_shift: "情绪变化",
    reflection: "反思",
    memory_formed: "形成记忆",
    world_state_change: "世界状态变化",
  };
  return labels[type] ?? prettifyToken(type);
}
