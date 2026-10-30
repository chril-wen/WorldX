/**
 * 「契约的载荷形状」的单测。
 *
 * ## 为什么这个要测
 *
 * 8.0 定契约时，载荷类型直接抄了 `@own-world/core` 的
 * `SimulationEvent`。8.3 换事件时实测发现：**两者不是同一份东西**。
 *
 * core 那份的字段（引擎内部形状）：
 *
 * ```
 * id / gameDay / gameTick / type / location / data / tags
 * actorId / targetId / innerMonologue / dramScore
 * ```
 *
 * 客户端实际收到的（API DTO 形状）：
 *
 * ```
 * 上面那些 + timeString / period（server 的 enrichEventTime 补的）
 *         + createdAt（类型上必填，运行时从来没有）
 * ```
 *
 * 差别有两处会**真的咬人**：
 *
 * - `createdAt` —— server 的事件表**根本没有 `created_at` 这一列**，
 *   但 `types/api.ts` 把它写成了必填。UI 里 `Date.parse(event.createdAt)`
 *   拿到的其实是 `undefined`，靠 `|| absTick` 兜底才没炸。
 * - `type` —— core 是 `SimEventType` 枚举，客户端是普通 `string`。
 *   枚举窄一点，运行时遇到枚举外的值就装不进去。
 *
 * 这些差别**不会报错**（结构上兼容），只会在换事件时变成
 * 一片「类型对不上」的连锁修改 —— 所以只能靠测试锁住。
 *
 * ## 这里测的是什么
 *
 * **契约的载荷类型必须和客户端实际用的一致**，
 * 而且**能和 core 那份双向互换** ——
 * 换事件时才能无痛替换，不引入连锁改动。
 */

import { describe, expect, it } from "vitest";
import type { SimulationEvent } from "@own-world/core/contracts/simulation.js";
import type {
  ClientSimulationEvent,
  ReplayInitFrame,
  WorldEventMap,
} from "./events.js";

/**
 * 客户端侧的 `SimulationEvent` —— 跟 `client/src/types/api.ts` 逐字相同。
 *
 * 这里**手抄**而不是 import client 的：
 *
 * - client 的 `types/api.ts` 属于**面板分支的地盘**（8.3 要动它），
 *   这里 import 会让两条分支的测试互相牵扯。
 * - 而且这份手抄本身就是**契约的对照物** ——
 *   如果两边不一致，测试要能报出来。
 */
interface ApiSimulationEvent {
  id: string;
  type: string;
  gameDay: number;
  gameTick: number;
  timeString?: string;
  period?: string;
  actorId?: string;
  targetId?: string;
  location?: string;
  data: any;
  innerMonologue?: string;
  dramScore?: number;
  createdAt: string;
}

describe("ClientSimulationEvent", () => {
  it("和客户端的 SimulationEvent 结构一致", () => {
    // 双向赋值 —— 结构不一致就会编译不过。
    const api = {} as ApiSimulationEvent;
    const client: ClientSimulationEvent = api;
    const back: ApiSimulationEvent = client;
    expect(back).toBe(api);
  });

  it("客户端事件能当作 core 的 SimulationEvent 用", () => {
    // core 那份 `data` 是 `Record<string, any>`，客户端是 `any` ——
    // 客户端更宽，所以能往下走。
    const client = {} as ClientSimulationEvent;
    const core: SimulationEvent = client;
    expect(core).toBeDefined();
  });

  /**
   * `type` 必须是 `string` 而不是 `SimEventType` 枚举。
   *
   * 运行时真的会冒出枚举外的值 ——
   * server 的 `god.ts` 路由能 `appendEvent` 任意类型的事件。
   * 用枚举会把那些事件**装不进类型**。
   */
  it("type 是普通 string，不是枚举", () => {
    const e: ClientSimulationEvent = {
      id: "x",
      type: "some_unseen_event_type",
      gameDay: 1,
      gameTick: 2,
      data: {},
      createdAt: "",
    };
    expect(e.type).toBe("some_unseen_event_type");
  });

  /**
   * `tags` 在 core 那份是必填，客户端是可选。
   *
   * 运行时确实有事件没有 `tags` ——
   * 实测 332 个真实事件里，`actorId`/`dramScore` 也是 328/332（有 4 个缺）。
   */
  it("tags 可选 —— 运行时有的事件没有", () => {
    const e: ClientSimulationEvent = {
      id: "x",
      type: "action_start",
      gameDay: 1,
      gameTick: 2,
      data: {},
      createdAt: "",
    };
    expect(e.tags).toBeUndefined();
  });

  /**
   * `location` 可选 —— core 那份是必填。
   *
   * 运行时缺 `location` 的事件实测有 4 个（`actorId` 同样 328/332）。
   */
  it("location 可选", () => {
    const e: ClientSimulationEvent = {
      id: "x",
      type: "action_start",
      gameDay: 1,
      gameTick: 2,
      data: {},
      createdAt: "",
    };
    expect(e.location).toBeUndefined();
  });
});

describe("ReplayInitFrame", () => {
  /**
   * `type: "init"` 是**判别字段** —— 运行时发的是整帧原样转发，
   * 这个字段一直都在（实测真实数据：init 帧的键是
   * `type` / `gameTime` / `characters`）。
   *
   * 8.0 漏了它，8.3 补上。
   */
  it("带 type 判别字段", () => {
    const frame: ReplayInitFrame = {
      type: "init",
      gameTime: { day: 1, tick: 0 },
      characters: [
        {
          id: "char_1",
          name: "沈四娘",
          location: "main_area",
          mainAreaPointId: "element_tea_counter",
        },
      ],
    };
    expect(frame.type).toBe("init");
  });
});

describe("WorldEventMap", () => {
  /**
   * 事件名和载荷是**照抄现有实现**的 —— 不是设计的。
   *
   * 实测代码里有 40+ 个事件名，设计稿里只有 7 个。
   * 8.3 换事件时按设计稿那 7 个重新设计，会有 30+ 个对不上。
   *
   * 所以这里锁住**载荷类型**，防止改契约时不知不觉改歪。
   */
  it("状态广播事件的载荷", () => {
    const time: WorldEventMap["time_update"] = {
      day: 1,
      tick: 2,
      timeString: "19:15",
      period: "夜晚",
    };
    expect(time.timeString).toBe("19:15");

    const status: WorldEventMap["simulation_status"] = { status: "running" };
    expect(status.status).toBe("running");
  });

  it("控制指令的载荷", () => {
    const zoom: WorldEventMap["camera_zoom_changed"] = 1.4;
    const pan: WorldEventMap["camera_pan_to"] = { x: 10, y: 20 };
    const follow: WorldEventMap["follow_character"] = "char_1";
    expect(zoom).toBe(1.4);
    expect(pan).toEqual({ x: 10, y: 20 });
    expect(follow).toBe("char_1");
  });

  it("相机状态的载荷", () => {
    const cam: WorldEventMap["camera_state"] = {
      x: 0,
      y: 0,
      width: 1024,
      height: 768,
      zoom: 1,
      mapWidth: 8192,
      mapHeight: 4608,
    };
    expect(cam.mapWidth).toBe(8192);
  });

  it("无载荷的事件用 void", () => {
    // `void` 意味着 emit 时**不能**带参数。
    const noPayload: WorldEventMap["camera_zoom_in"] = undefined;
    expect(noPayload).toBeUndefined();
  });
});
