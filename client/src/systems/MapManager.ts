/**
 * 地图数据层已迁到 `@own-world/client-core` —— 这里保留 re-export，
 * 既有 import 路径不破。
 *
 * 跟阶段 1 对 server 的做法一样：`server/src/core/*.ts` 迁到
 * `packages/core` 之后，server 侧留一层门面。
 *
 * 为什么需要门面：client 里有 3 个文件 import 这两个类
 * （`WorldScene` / `CharacterMovement` / 各自的测试）。
 * 直接改 import 路径也行，但门面能保证**外部引用也不破**
 * —— client-core 以后要换实现（比如换 A* 库），改一处就够。
 */
export { MapManager } from "@own-world/client-core";
export type {
  InteractiveObject,
  LocationRect,
  MainAreaPointNode,
} from "@own-world/client-core";
