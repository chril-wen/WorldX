# 8.3 面板层分支 —— 交底

> 这份文档是给**接手面板层那条分支**的人（或会话）看的。
> 目标是：不用重读整个仓库，就能开始干活。

---

## 一句话现状

阶段 8.3 分成两条**互不重叠**的并行分支：

| 分支 | 做什么 | 状态 |
|---|---|---|
| `refactor/phase-8-3-runtime` | 事件总线的实现 + 生产侧迁移 | ✅ **已完成** |
| `refactor/phase-8-3-ui-panel` | 面板层从 EventBus 换到新契约 | 🔲 **你来接手** |

两条分支**共享同一个基座**（下面第二节的四个接缝提交），
所以各自都能独立编译、独立测试通过。

**合并演练已经做过**：面板分支做改动 → 合并 runtime 分支 → **无冲突**。

---

## 你在哪个目录工作

**面板分支有独立的 worktree**：`E:\WordX\OWN-World-8.3-panel`

```
E:\WordX\OWN-World            →  refactor/phase-8-3-runtime   （生产侧，已完成）
E:\WordX\OWN-World-8.3-panel  →  refactor/phase-8-3-ui-panel   ← 你在这里
```

**两个目录互不干扰**，可以同时开着。

⚠ **worktree 里有几个坑，已经踩过并解决了**（如果你重新建 worktree，照着做）：

1. **`node_modules` 不会自动跟过去** —— worktree 是干净的检出。
   这里的做法是**做 Windows 目录联接（junction）**，指向主检出的：
   ```
   mklink /J node_modules            E:\WordX\OWN-World\node_modules
   mklink /J client\node_modules     E:\WordX\OWN-World\client\node_modules
   mklink /J server\node_modules     E:\WordX\OWN-World\server\node_modules
   mklink /J packages\core\node_modules     E:\WordX\OWN-World\packages\core\node_modules
   mklink /J orchestrator\node_modules       E:\WordX\OWN-World\orchestrator\node_modules
   mklink /J generators\node_modules         E:\WordX\OWN-World\generators\node_modules
   ```
   ⚠ `packages/client-core` **不用**联接 —— 它本来就没有自己的
   `node_modules`（依赖 `eventemitter3` 从根 `node_modules` 解析）。

2. **构建产物不在 git 里** —— worktree 里**没有** `packages/core/dist`
   和 `server/dist`，而 `orchestrator` 的测试**要**它们。
   建完 worktree 先跑：
   ```bash
   npm run build:core && npm run build:server
   ```
   不跑的话会有 18 个测试**假红**（报 `Cannot find module`）。

3. **真实世界数据不在 git 里** —— `output/worlds/*/` 和 `server/data`
   是 gitignore 的运行期数据。CLI 和 orchestrator 的测试**要**它们：
   ```
   mklink /J output\worlds  E:\WordX\OWN-World\output\worlds
   mklink /J server\data    E:\WordX\OWN-World\server\data
   ```

**这四步做完，`npm run typecheck` 和 `npm test` 就都绿了**（本 worktree 已验证：
typecheck 0 错误，**875 / 875 测试全过**）。

> 📄 **这份文档本身就在面板分支上**（提交 `9c85e10`）——
> 也就是说，**文档是在分支建好之后才写的**。
> 如果你从 `refactor/phase-8-3-event-contract`（接缝分支）出发，
> 先 `git merge refactor/phase-8-3-ui-panel` 拿这份文档，
> 或者直接看 worktree 里的这份。

---

## 你的任务是什么

**把面板层（`client/src/ui/**`）从 Phaser 的 EventBus 换到契约的总线上，
行为一个字都不许变。**

具体就是这些：

| 文件 | 要做什么 |
|---|---|
| `client/src/ui/App.tsx` | 订阅的 9 个事件改用契约类型；`emit` 的 11 处改用契约类型 |
| `client/src/ui/panels/MapControls.tsx` | 同上（2 订阅 + 5 emit） |

**别的面板文件大概率不用动** —— 它们是通过 props 拿数据的，
不直接碰事件总线。

### 验收标准

- [ ] 现有 15 个面板**行为不变**（`types/api.ts` **不动**）
- [ ] `grep -rn "phaser" client/src/ui/` → **只剩注释**，没有 import
- [ ] `npm run typecheck` 全绿
- [ ] `npm test` 全绿
- [ ] **浏览器实测**：面板能收到事件、按钮能发指令

---

## 基座：四个接缝提交（**已经做完了，不用重做**）

分支基点在这四个提交上：

```
b256ff1  feat(client-core): 补 `WorldTimeInfo` 别名和 `DialogueEventData` 转出
348b158  test(client-core): 锁住「面板层不依赖 Phaser」
ee812eb  refactor(client): 生产侧接到契约的总线上
668950f  refactor(client): 面板的 eventBus prop 改成契约类型
3e9d009  feat(client-core): 事件总线的实现 —— 零依赖，与 eventemitter3 逐条等价
9769171  fix(client-core): 事件载荷改成客户端真正收到的形状
17b1613  fix(client): client 的 tsconfig 解析到 client-core 源码，不是过期 dist
```

它们做了什么：

1. **`17b1613`** —— client 的 tsconfig 之前解析到**过期的 dist**，
   现在解析到 client-core **源码**。
   ⚠ **不修这个，两条分支会各编译各的，还都「通过」，合起来对不上。**
2. **`9769171`** —— 契约的载荷类型从 core 的 `SimulationEvent`
   改成**客户端真正收到**的形状（`ClientSimulationEvent`）。
3. **`3e9d009`** —— 事件总线的**实现**（`createWorldEventBus` / `worldEventBus`）。
4. **`668950f`** —— 面板的 `eventBus` prop 类型改成 `WorldEventBus`。
   **这就是你要改的那两个文件的类型标注部分 —— 已经改好了。**
5. **`348b158`** —— 锁住「UI 层不 import Phaser」的测试。
6. **`b256ff1`** —— `WorldTimeInfo` 别名 + `DialogueEventData` 转出。

---

## 契约长什么样

全在 `packages/client-core/src/render/events.ts`：

```ts
import type {
  WorldEventBus, WorldEventMap, WorldEventName,
  ClientSimulationEvent, ClientWorldTime, WorldTimeInfo,
  CameraStatePayload, CharacterSummary, ReplayInitFrame,
  SimulationStatus, PlaybackMode, DialogueEventData,
} from "@own-world/client-core";
```

`WorldEventBus` 接口：

```ts
interface WorldEventBus {
  on<K extends WorldEventName>(event: K, listener: (payload: WorldEventMap[K]) => void): void;
  off<K extends WorldEventName>(event: K, listener: (payload: WorldEventMap[K]) => void): void;
  once<K extends WorldEventName>(event: K, listener: (payload: WorldEventMap[K]) => void): void;
  emit<K extends WorldEventName>(event: K, ...args: WorldEventMap[K] extends void ? [payload?: undefined] : [payload: WorldEventMap[K]]): void;
}
```

### 事件名**不要改**

契约是**照抄现有实现**的 —— 事件名和载荷都一模一样。
不是重新设计。改名字 = 改行为。

面板层现在用的事件（全部 11 个）：

```
时间状态   time_update / simulation_status / playback_state
模拟事件   sim_event / dialogue / global_event
角色相机   character_clicked / camera_state / camera_zoom_changed
控制指令   camera_zoom_in / camera_zoom_out / camera_zoom_fit /
           camera_zoom_reset / camera_pan_to
跟随       follow_character / unfollow_character
播放控制   set_auto_play / set_tick_interval / set_cycle_ticks /
           dev_advance_tick
回放       start_replay / stop_replay / set_replay_mode / replay_init /
           replay_progress / replay_finished / replay_ended
场景       scene_ending / scene_covered / scene_sync_characters
内部信号   tick_playback_started / tick_playback_events_flushed /
           tick_playback_complete
调试       toggle_debug_*_overlay（4 个）
```

---

## 三个必须知道的坑

### 坑 1：类型**不对称** —— 边界必须在面板侧切

实测：

| 方向 | 行不行 |
|---|---|
| `Phaser.Events.EventEmitter` → `WorldEventBus` | ✅ 行（结构兼容） |
| `WorldEventBus` → `Phaser.Events.EventEmitter` | ❌ **不行** |

反向不行是因为 Phaser 的类型还要求
`shutdown` / `destroy` / `eventNames` / `listeners` /
`listenerCount` / `removeAllListeners` / `addListener` 这 8 个方法。

**所以**：prop 类型必须从 `Phaser.Events.EventEmitter` 改成 `WorldEventBus`
（接缝提交 `668950f` 已经改好了 prop 类型标注，
但**你可能还要改 handler 里的类型标注**）。

### 坑 2：`types/api.ts` **不动**

8.3 的验收标准明说「`types/api` 不动」。

所以面板层里那些 `SimulationEvent` / `WorldTimeInfo` 的用法，
**名字保持不变**，只改 import 来源：

```ts
// 改前
import type { SimulationEvent, WorldTimeInfo } from "../types/api";
// 改后（名字不变，来源变）
import type { ClientSimulationEvent, WorldTimeInfo } from "@own-world/client-core";
```

⚠ `SimulationEvent` 在契约里叫 **`ClientSimulationEvent`**。
`WorldTimeInfo` 契约里**同名**（是 `ClientWorldTime` 的别名）。

`WorldEventMap["sim_event"]` 的载荷类型已经是 `ClientSimulationEvent`，
所以 handler 里的标注也能直接用契约的类型。

### 坑 3：`once` 的语义跟 `EventTarget` 不一样

新总线**不是** `EventTarget`（那会去掉重订阅、改变行为）。
它跟 `eventemitter3` 逐条等价：

- 同一个函数订阅两次 → **触发两次**
- `once` **触发前**就摘（所以回调里重入不会递归）
- `off` 摘掉**所有**注册（`on` 的和 `once` 的都摘）
- 触发期间的订阅变更**不影响本次触发**（遍历快照）

对拍测试在 `packages/client-core/src/render/event-bus.test.ts`，
基准是 `eventemitter3` 本身。**别改这个测试的基准。**

---

## 怎么验证「行为没变」

⚠ **编译通过不等于行为没变**（8.2 的教训：「比对通过 ≠ 画对了」）。

浏览器实测清单（server 和 client 都要起）：

| 验证项 | 怎么验 | 期望 |
|---|---|---|
| 状态广播 | 看顶栏时间 | 显示 `亥时正 (21:30)` 之类（**不是**初始的 `08:00`） |
| 相机广播 | 看缩放百分比 | 有数字（不是 `100%`） |
| 控制指令 | 点「放大」按钮 | 缩放数字**变**（如 84% → 118%） |
| 播放控制 | 点「开始运行」 | 时间前进、状态变「运行中」、按钮变「暂停运行」 |
| 模拟事件 | 看角色状态 | 角色的状态描述**会变** |
| 对话事件 | 点角色，看「近期对话」 | 有完整对话内容 |
| 控制台 | —— | **零错误** |

### 特别要盯的：**订阅次数**

如果不小心让同一个 handler 订阅了两次（比如 `useEffect` 的依赖数组写错），
事件会**处理两次** —— 表现是对话气泡弹两次、角色状态闪。

React StrictMode 会把 effect 跑两遍，所以**这个在开发模式下也能看出来**。

---

## 不要做的事

- ❌ **不要改 `types/api.ts`** —— 验收标准明说不动
- ❌ **不要改事件名** —— 契约是照抄现有实现的
- ❌ **不要改 `packages/client-core/src/render/events.ts` 的载荷形状** ——
  那是共同地基，改了 runtime 分支会崩
  （真要改，先跟 runtime 分支的负责人对一下）
- ❌ **不要动 `client/src/scenes/` `client/src/systems/` `client/src/EventBus.ts`** ——
  那是 runtime 分支的地盘
- ❌ **不要用 `EventTarget` 实现总线** —— 语义不对（坑 3）
- ❌ **不要推远程** —— 全局约束

---

## 收尾

做完之后：

1. `npm run typecheck` 全绿
2. `npm test` 全绿
3. 浏览器实测清单逐条过
4. 在 `E:\WordX\OWN-World-design\product\REPORTS\phase-08.md` 追加 8.3 的汇报
5. **不推远程**，等批复

---

## 参考

- 契约：`packages/client-core/src/render/events.ts`
- 总线实现：`packages/client-core/src/render/event-bus.ts`
- 对拍测试：`packages/client-core/src/render/event-bus.test.ts`
- 载荷形状测试：`packages/client-core/src/render/events.test.ts`
- UI 独立性测试：`packages/client-core/src/render/ui-independence.test.ts`
- 阶段 8 总计划：`E:\WordX\OWN-World-design\product\PLAN-phase-8-ui-render.md`
- 阶段 8 汇报：`E:\WordX\OWN-World-design\product\REPORTS\phase-08.md`
