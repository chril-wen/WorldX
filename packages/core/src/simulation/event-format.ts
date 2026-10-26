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
 * 引擎内部的 action id → 人话。
 *
 * ## 为什么需要这张表
 *
 * 有些 action 是**引擎内部的状态标记**，没有对应的「世界动作」：
 *
 * - `post_dialogue` —— 对话结束后的空闲期（`finishDialogueSession` 写的）
 * - `traveling` —— 移动中
 * - `idle` —— 无事可做
 *
 * 这些事件走到 `action-executor.ts` 的**兜底分支**，
 * `data` 里只有 `action: "post_dialogue"`，**没有 `actionName`**。
 * 渲染时只能显示裸 id —— 「赵龙 结束post_dialogue」。
 *
 * client 有同样的问题（`actionName` 也是裸 id）。
 *
 * ## 为什么放在 core
 *
 * 这是**取值**，不是展示 —— client 和 CLI 都需要它，
 * 放一处才不会各写一份、各漏几个。
 */
const INTERNAL_ACTION_LABELS: Record<string, string> = {
  post_dialogue: "闲聊余温",
  traveling: "赶路",
  idle: "闲待",
  in_conversation: "对话中",
  explore: "四下看看",
  rest: "歇着",
};

/**
 * 把 action 翻成人话。
 *
 * ## 两个参数的区别
 *
 * - `actionId` —— **内部 id**（`data.action`）：`post_dialogue`、`traveling`、`idle`
 * - `displayName` —— **已有的显示名**（`data.actionName`）：「找人攀谈」「闲逛观察」
 *
 * ## 为什么不能直接用 `extractEventActionName` 的结果
 *
 * 那个函数的字段优先级是 `actionName` → `interactionName` → `action` → …，
 * 意思是「取到哪个算哪个」。但 `data.action` 有时是**内部 id**
 * （`post_dialogue`），不是显示名 —— 直接拿来做显示就露馅了
 * （「赵龙 结束post_dialogue」）。
 *
 * 所以这里**分开取**：显示名优先用 `data.actionName`，
 * 没有才拿 `data.action` 去查内部 action 表。
 *
 * @param {string|null|undefined} actionId 内部 action id（`data.action`）
 * @param {string|null|undefined} displayName 已有的显示名（`data.actionName`）
 * @returns {string} 人话；实在没有就返回空串
 */
export function actionLabel(
  actionId: string | null | undefined,
  displayName?: string | null,
): string {
  if (displayName && displayName.length > 0) return displayName;
  if (!actionId) return "";
  const label = INTERNAL_ACTION_LABELS[actionId];
  if (label) return label;
  return prettifyToken(actionId);
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
