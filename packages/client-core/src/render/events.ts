/**
 * 事件契约 —— 替代 Phaser 的 `EventBus` 单例。
 *
 * ## 为什么要有这个文件
 *
 * 现在整个 client 靠一个 `Phaser.Events.EventEmitter` 单例通信：
 *
 * ```
 * client/src/EventBus.ts
 *   export class EventBus {
 *     static instance: Phaser.Events.EventEmitter = new Phaser.Events.EventEmitter();
 *   }
 * ```
 *
 * 面板层（8378 行 React）为了拿它，要 import Phaser ——
 * **一个只为了传消息的依赖，把整个 UI 绑在了渲染引擎上**。
 *
 * 实测 `client/src/ui/` 里引用 Phaser 的只有 3 个文件，
 * 全部只为了这个 EventBus 的类型。
 *
 * 这个文件把事件的名字和载荷**定死**，然后用 `EventTarget` 实现 ——
 * 零依赖，浏览器原生，谁都能用。
 *
 * ## 事件清单是**从现有代码倒推**的，不是设计的
 *
 * 阶段 8 的设计稿里列了 7 个事件（`tick_advanced`、`character_moved`…），
 * 但代码里实际有 **40+ 个**事件名，载荷形状也完全不同。
 *
 * 如果按设计稿那 7 个重新设计，8.3 换事件的时候
 * 会有 30+ 个事件**对不上** —— 要么丢，要么重新设计载荷。
 *
 * 所以这里按**现有实现逐条对齐**：事件名一模一样，载荷一模一样。
 * 8.3 换事件时是**照抄**，不是重新设计 —— 零行为漂移。
 *
 * ## 事件分三类
 *
 * | 类别 | 谁发谁收 | 例子 |
 * |---|---|---|
 * | **状态广播** | 系统 → 面板 | `time_update`、`simulation_status` |
 * | **控制指令** | 面板 → 系统 | `camera_zoom_in`、`set_auto_play` |
 * | **内部信号** | 系统内部 | `tick_playback_complete` |
 *
 * 契约层**不区分**这三类 —— 它们都是「一个名字 + 一个载荷」。
 * 但注释里标了，因为 8.3 换事件时，**控制指令是双向的**，
 * 换成 `EventTarget` 时要小心（见下面的「一次性事件」）。
 *
 * ## 载荷里的类型从哪来
 *
 * `ClientSimulationEvent` 用的是**客户端真正收到的事件形状** ——
 * 不是 `@own-world/core` 的 `SimulationEvent`。
 *
 * ## 为什么不用 core 的 `SimulationEvent`
 *
 * 8.0 定契约时，这里直接用了 core 的 `SimulationEvent`。
 * 8.3 换事件时实测发现：**两者不是同一份东西**。
 *
 * 扫了 `output/worlds` 下所有时间线的 `events.jsonl`（**332 个真实事件**），
 * 字段只有这些：
 *
 * ```
 * id / gameDay / gameTick / type / location / data / tags
 * actorId / targetId / dramScore / innerMonologue
 * ```
 *
 * 对比 core 的 `SimulationEvent`：
 *
 * | 字段 | core | 客户端实际 |
 * |---|---|---|
 * | `tags` | 有 | 有 |
 * | `timeString` / `period` | **无** | **有** —— server 的 `enrichEventTime` 补的 |
 * | `createdAt` | **无** | 类型上**要求有**，运行时**从来没有** |
 * | `location` | 必填 | 可缺 |
 * | `type` | `SimEventType` 枚举 | `string` |
 *
 * `createdAt` 那个字段是**假的必填** —— server 的事件表
 * （`server/src/store/event-store.ts` 的 `INSERT_SQL`）
 * **根本没有 `created_at` 这一列**。
 * `types/api.ts` 里写成了 `createdAt: string`（必填），
 * UI 里 `Date.parse(event.createdAt)` 拿到的其实是 `undefined`，
 * 靠 `|| absTick` 兜底才没炸。
 *
 * 所以这里定义**客户端形状**，而不是 core 的引擎形状 ——
 * 契约描述的应该是**线上真正在传的东西**。
 *
 * `ClientWorldTime` 同理：用 core 的 `time-helpers` 那份
 * （`GameTime` 逐字相同），不是 client 自己抄的
 * （client 侧 `types/api.ts` 那份是**扩展版**，多了 `weather`）。
 */

import type { DialogueEventData } from "@own-world/core/contracts/simulation.js";
import type { GameTime, WeatherKind } from "@own-world/core/contracts/world.js";

/**
 * 客户端收到的事件 —— **线上真正在传的那份形状**。
 *
 * ## 为什么 `createdAt` 是必填但运行时没有
 *
 * 这是**故意跟 `types/api.ts` 保持一致**的。
 *
 * 改��可选会在 8.3 造成一大片连锁修改（面板层好几十处 `event.createdAt`），
 * 而运行时它**本来就是 `undefined`** —— 类型改不改，行为一模一样。
 *
 * 真正的修法是**先让 server 补上 `created_at` 这一列**，
 * 那时这个字段才有意义。现在先不动 ——
 * 类型上必填，是为了跟 `types/api.ts` 对齐，接缝期不引入连锁改动。
 */
export interface ClientSimulationEvent {
  id: string;
  /** 事件类型。运行时是普通字符串（`action_start`、`dialogue`…）。 */
  type: string;
  gameDay: number;
  gameTick: number;
  /** 场景内时刻，如 `"19:15"` —— server 的 `enrichEventTime` 补的。 */
  timeString?: string;
  /** 时段标签，如 `"夜晚"` —— server 的 `enrichEventTime` 补的。 */
  period?: string;
  actorId?: string;
  targetId?: string;
  /** 事件发生的地点。 */
  location?: string;
  /** 事件载荷。对话事件里是 `DialogueEventData`。 */
  data: any | DialogueEventData;
  innerMonologue?: string;
  dramScore?: number;
  /** ⚠ 类型上必填，运行时**从来没有**（见上面的说明）。 */
  createdAt: string;
  /** 事件标签，core 那边是必填。 */
  tags?: string[];
}

/**
 * 世界时间 —— 客户端看到的时间。
 *
 * **比 core 的 `WorldTimeInfo` 多了 `weather`** ——
 * 顶栏要显示天气（`TopBar.tsx` 的 `weatherIcon`）。
 *
 * 引擎本身不产生 weather，它在**世界全局状态**里
 * （`WeatherManager`），是客户端另外拉来拼进时间信息的。
 */
export interface ClientWorldTime extends GameTime {
  /** 场景内时刻，如 `"19:15"`。 */
  timeString: string;
  /** 时段标签，如 `"夜晚"`。 */
  period: string;
  weather?: {
    kind: WeatherKind;
    label: string;
  };
}

/**
 * `WorldTimeInfo` —— `ClientWorldTime` 的**旧名字**。
 *
 * ## 为什么留这个别名
 *
 * 面板层现在用的是 `client/src/types/api.ts` 里的 `WorldTimeInfo`。
 * 8.3 换契约时，那些 import 要改成 client-core 的名字。
 *
 * 而 `types/api.ts` **不动**（8.3 的验收标准之一）——
 * 所以面板层里那些 `WorldTimeInfo` 的用法，**名字不变**才是最小改动。
 *
 * 契约起名 `ClientWorldTime` 是为了跟 core 的 `WorldTimeInfo` 区分
 * （client 那份多了 `weather`）——
 * 但两个名字指的是**同一个形状**（实测结构逐字相同），
 * 所以这里给个别名，让面板层迁移时**只需要改 import 来源，不用改用法**。
 */
export type WorldTimeInfo = ClientWorldTime;

/** 模拟状态。 */
export type SimulationStatus =
  | "idle"
  | "running"
  | "pausing"
  | "paused"
  | "error";

/** 播放模式。 */
export type PlaybackMode = "live" | "replay";

/** 相机状态 —— `camera_state` 事件的载荷。 */
export interface CameraStatePayload {
  /** 视口左上角对应的世界坐标。 */
  x: number;
  y: number;
  /** 视口尺寸（世界像素）。 */
  width: number;
  height: number;
  zoom: number;
  /** 地图尺寸（世界像素）。 */
  mapWidth: number;
  mapHeight: number;
}

/** 角色面板需要的角色摘要。 */
export interface CharacterSummary {
  id: string;
  name: string;
  location: string;
  mainAreaPointId: string | null;
}

/**
 * 回放初始化帧 —— `replay_init` 事件的载荷。
 *
 * ## 为什么带 `type: "init"`
 *
 * 运行时发的是**时间线文件里的整帧**（`events.jsonl` 的第一行），
 * 判别字段是它的一部分。实测真实数据：
 *
 * ```
 * { type: "init", gameTime: { day: 1, tick: 0 }, characters: [...] }
 * ```
 *
 * 8.0 定契约时把这个字段**漏掉了** —— 但 `PlaybackController`
 * 是整个帧原样转发（`emit("replay_init", initFrame)`），
 * 所以运行时**一直带着**它。
 *
 * 补上它，接收方才能靠 `type` 判别这是 init 帧而不是 tick 帧。
 */
export interface ReplayInitFrame {
  /** 判别字段 —— 固定是 `"init"`。 */
  type: "init";
  gameTime: GameTime;
  characters: CharacterSummary[];
}

/**
 * 事件名 → 载荷类型。
 *
 * **载荷类型一律显式给出**，不用 `unknown` ——
 * 这样 8.3 换事件时，`on("camera_state", cb)` 的 `cb` 参数
 * 自动就有类型，不用手写断言。
 *
 * 没有载荷的事件用 `void`。
 */
export interface WorldEventMap {
  // ── 时间与状态（系统 → 面板）────────────────────────────

  /** 世界时间变了。 */
  time_update: ClientWorldTime;
  /** 模拟状态变了。 */
  simulation_status: {
    status?: SimulationStatus;
    /** 出错时的错误信息（`status: "error"` 时有）。 */
    message?: string;
    /** 是否自动播放。 */
    autoPlay?: boolean;
    /** tick 间隔（毫秒）。 */
    tickIntervalMs?: number;
    /** 本 tick 产出的事件数。 */
    eventCount?: number;
  };
  /** 播放状态（自动播放开关、模式）。 */
  playback_state: {
    autoPlay?: boolean;
    tickIntervalMs?: number;
    mode?: PlaybackMode;
  };

  // ── 模拟事件（系统 → 面板）──────────────────────────────

  /** 一个模拟事件（所有类型）。 */
  sim_event: ClientSimulationEvent;
  /** 对话事件。载荷是 `ClientSimulationEvent`，对话内容在 `data` 里。 */
  dialogue: ClientSimulationEvent;
  /** 世界级事件（`event_triggered`）。 */
  global_event: ClientSimulationEvent;

  // ── 角色与相机（双向）──────────────────────────────────

  /** 角色被点击。 */
  character_clicked: string;
  /** 相机状态变了。 */
  camera_state: CameraStatePayload;
  /** 相机缩放变了。 */
  camera_zoom_changed: number;

  // ── 相机控制指令（面板 → 系统）──────────────────────────

  camera_zoom_in: void;
  camera_zoom_out: void;
  camera_zoom_fit: void;
  camera_zoom_reset: void;
  /** 平移到指定世界坐标。 */
  camera_pan_to: { x: number; y: number };

  // ── 跟随（面板 → 系统）─────────────────────────────────

  follow_character: string;
  unfollow_character: void;

  // ── 播放控制（面板 → 系统）──────────────────────────────

  set_auto_play: boolean;
  set_tick_interval: number;
  set_cycle_ticks: number;
  /** 手动推进一个 tick（开发用）。 */
  dev_advance_tick: void;

  // ── 回放（双向）────────────────────────────────────────

  start_replay: string;
  stop_replay: void;
  /** 回放模式开关。 */
  set_replay_mode: { active: boolean };
  /** 回放初始化 —— 带初始角色位置。 */
  replay_init: ReplayInitFrame;
  /** 回放进度。 */
  replay_progress: { current: number; total: number };
  /** 一段回放放完了。 */
  replay_finished: void;
  /** 回放结束（整体结束，不是单段）。 */
  replay_ended: void;

  // ── 场景切换（系统 → 面板 → 系统）──────────────────────

  /** 一天结束了（要放幕布转场）。 */
  scene_ending: { day: number };
  /** 幕布已经盖住屏幕。 */
  scene_covered: void;
  /** 让场景重新同步角色（跨天时角色位置会变）。 */
  scene_sync_characters: void;

  // ── tick 播放内部信号（系统内部）────────────────────────

  /** 一个 tick 的回放开始了。 */
  tick_playback_started: {
    gameTime: GameTime;
    eventCount: number;
  };
  /** 这个 tick 的事件都发完了。 */
  tick_playback_events_flushed: {
    gameTime: GameTime;
    eventCount: number;
  };
  /** 这个 tick 播完了（内部完成信号）。 */
  tick_playback_complete: void;

  // ── 调试覆盖层（面板 → 系统）────────────────────────────

  toggle_debug_walkable_overlay: boolean;
  toggle_debug_region_bounds_overlay: boolean;
  toggle_debug_main_area_points_overlay: boolean;
  toggle_debug_interactive_objects_overlay: boolean;
}

/** 事件名的联合类型。 */
export type WorldEventName = keyof WorldEventMap;

/**
 * 类型安全的事件总线。
 *
 * ## 为什么不用 `EventTarget`
 *
 * `EventTarget` 的 `addEventListener` 签名里，事件名是 `string`，
 * 载荷是 `Event` —— **类型信息全丢**。
 *
 * 要拿到类型，得自己包一层，把 `CustomEvent<T>` 的 `detail` 拆出来。
 * 这一层就是下面这个接口。
 *
 * ## 一次性事件
 *
 * `once` 是**必需**的，不是可选 —— `scene_covered` 就是一次性信号
 * （`PlaybackController` 用 `once("scene_covered", ...)` 等幕布落下）。
 *
 * 换成 `EventTarget` 时，`once` 要自己实现（`addEventListener` + 手动移除）。
 */
export interface WorldEventBus {
  /** 订阅。 */
  on<K extends WorldEventName>(
    event: K,
    listener: (payload: WorldEventMap[K]) => void,
  ): void;
  /** 取消订阅。 */
  off<K extends WorldEventName>(
    event: K,
    listener: (payload: WorldEventMap[K]) => void,
  ): void;
  /** 订阅一次，触发后自动取消。 */
  once<K extends WorldEventName>(
    event: K,
    listener: (payload: WorldEventMap[K]) => void,
  ): void;
  /** 发事件。 */
  emit<K extends WorldEventName>(
    event: K,
    ...args: WorldEventMap[K] extends void
      ? [payload?: undefined]
      : [payload: WorldEventMap[K]]
  ): void;
}
