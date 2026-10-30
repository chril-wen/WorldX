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
 * `SimulationEvent` / `DialogueEventData` 直接用 `@own-world/core` 的 ——
 * 那是**引擎的真实类型**，客户端拿到的就是它。
 *
 * `WorldTimeInfo` 用 core 的 `time-helpers` 那一份，
 * 不是 client 自己抄的（client 侧 `types/api.ts` 那份是**扩展版**，
 * 多了 `weather`）。
 */

import type {
  DialogueEventData,
  SimulationEvent,
} from "@own-world/core/contracts/simulation.js";
import type { GameTime, WeatherKind } from "@own-world/core/contracts/world.js";

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

/** 回放初始化帧 —— `replay_init` 事件的载荷。 */
export interface ReplayInitFrame {
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
  sim_event: SimulationEvent;
  /** 对话事件。载荷是 `SimulationEvent`，对话内容在 `data` 里。 */
  dialogue: SimulationEvent;
  /** 世界级事件（`event_triggered`）。 */
  global_event: SimulationEvent;

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
