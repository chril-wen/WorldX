/**
 * 寻路已迁到 `@worldx/client-core` —— 这里保留 re-export，
 * 既有 import 路径不破。
 *
 * 跟 `MapManager.ts` 同理：实现搬走了，路径留着。
 */
export { PathfindingManager } from "@worldx/client-core";
export type { GridPoint, StepAxis } from "@worldx/client-core";
