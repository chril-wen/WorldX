# 架构总览

> **目标读者**：接手某个模块的人。你应该能靠这一份 + 对应模块的文档，
> 在**不读全部代码**的前提下定位问题、改动它。
>
> **怎么用这份文档**：先看 [§2 依赖方向](#2-依赖方向不可违反的三条) 判断你要动的东西
> 允许碰哪一层，再跳到对应章节。

---

## 1. 一句话

OWN-World 是一个 **LLM 驱动的角色社会模拟器**：
一句话描述 → 生成一张地图和一群有身份的角色 → 角色在自己的内部状态
（情绪 / 需求 / 记忆）驱动下持续行动、互相交谈、产生故事。

**它不是**「AI 换皮 NPC」——角色不是状态机，是有内部状态、会衰减、会演化的存在。

---

## 2. 依赖方向（不可违反的三条）

```
                    ┌──────────────┐
                    │  generators/ │  地图块、角色素材的生成
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │ orchestrator/ │  世界生成流程编排
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
      ┌───────▼──────┐ ┌───▼──────┐ ┌──▼──────────┐
      │ packages/core │ │  server/ │ │packages/    │
      │  模拟引擎     │ │ HTTP 层  │ │client-core  │
      │  零框架依赖   │ │          │ │ 地图数据层   │
      └───────┬──────┘ └───┬──────┘ └──┬──────────┘
              │            │           │
              │      ┌─────▼─────┐     │
              │      │  client/  │─────┘
              │      │ Phaser UI │  client 依赖 client-core
              │      └───────────┘
              │
      ┌───────▼──────────────────────────┐
      │  plugins/  插件（挂到 orchestrator 的钩子上） │
      └──────────────────────────────────┘
```

### 规则 1：`packages/core` 不碰框架

core 里**没有** Express、better-sqlite3、Phaser、React。
它只依赖标准库 + `zod` + `nanoid`。

**为什么**：core 是**要被复用的**。同一套模拟引擎应该能跑在
server、CLI、测试、甚至浏览器里。框架依赖一旦进来，复用就没了。

**怎么检查**：

```bash
grep -rhn "^import .*from" packages/core/src/ | grep -E '"express"|"phaser"|"react"|better-sqlite3'
```

命中数应该是 **0**。core 的 `dependencies` 只有 `zod` 和 `nanoid`。

（注意别用 `grep -rn "react"` —— 命中的全是 `reactive` 这个词。）

### 规则 2：依赖只能从上往下

`client → client-core → core`，`server → core`，`orchestrator → core`。

**例外**：`client-core → core` 是允许的，而且**必须**是子路径导入：

```ts
import { parseTmj } from "@own-world/core/engine/tmj-parser.js";   // ✅
import { parseTmj } from "@own-world/core";                        // ❌
```

从包根导入会把整个 core（包括 `engine/world-manager.js` 里的
`node:fs` 和顶层 `process.env`）拖进浏览器 bundle。

### 规则 3：插件不反向依赖 core

插件挂在 orchestrator 的**生成流程**上，不是模拟流程上。
插件契约在 `orchestrator/src/plugins/plugin-contract.mjs` 而不是 `packages/core`，
因为加载插件**必须读文件系统**（扫 `plugins/` 目录），
而 core 定了「不碰文件系统」的边界。

---

## 3. 模块地图

按「要改什么」来找模块：

| 你要改… | 去哪 | 关键文件 |
|---|---|---|
| 角色的**决策 / 对话 / 行动** | `packages/core/src/simulation/` | `perceiver.ts` → `decision-maker.ts` → `dialogue-generator.ts` → `action-executor.ts` |
| **情绪 / 需求 / 记忆** | `packages/core/src/engine/` | `emotion-manager.ts` / `needs-manager.ts` / `memory-manager.ts` |
| **世界规则**（数值） | `packages/core/src/engine/rules.ts` | 规则是**数据**（`RULE_RANGES`），不是代码里的常数 |
| **世界配置**（结构） | `packages/core/src/contracts/world.ts` | `LocationConfig` / `ObjectConfig` / `MainAreaPointConfig` |
| **地图解析** | `packages/core/src/engine/tmj-parser.ts` | 全仓**唯一**一份 TMJ 解析 |
| **世界状态的读写** | `packages/core/src/engine/world-manager.ts` | 世界的一切入口 |
| **HTTP 接口** | `server/src/api/routes/` | 每个文件一个资源域 |
| **数据库** | `server/src/store/` | SQLite |
| **世界生成流程** | `orchestrator/src/index.mjs` | 一句话 → 世界目录 |
| **地图生成** | `generators/map/src/` | 画图 + 视觉模型定位区域 |
| **地图数据层**（前端用） | `packages/client-core/src/` | `MapManager` / `PathfindingManager` |
| **UI** | `client/src/ui/` | React 面板 |
| **游戏画面** | `client/src/scenes/WorldScene.ts` | Phaser，927 行 |
| **角色在地图上移动** | `client/src/systems/CharacterMovement.ts` | 547 行 |
| **世界规则 CLI** | `scripts/rules.mjs` | 改规则的界面 |
| **时间线 / 快照** | `scripts/timeline.mjs` | 快照、分叉、对比 |

---

## 4. 一次模拟 tick 走过的路

```
POST /api/simulation/tick
        │
        ▼
server/src/api/routes/simulation.ts
        │  检查 worldId / timelineId 没变（防止在别的世界上推进）
        ▼
packages/core/src/simulation/simulation-engine.ts
        │
        ├─▶ perception.ts     每个角色「看到」什么
        │     └─ 感知规则来自 rules.ts（可调）
        │
        ├─▶ action-menu-builder.ts   给角色一张「能做什么」的菜单
        │     └─ 菜单内容 = 当前状态 + 邻接地点 + 在场的人
        │
        ├─▶ decision-maker.ts  LLM 从菜单里挑一个
        │     └─ 输出走 output-schemas.ts 校验
        │
        ├─▶ dialogue-generator.ts   两个角色碰面 → 对话
        │
        └─▶ action-executor.ts   执行动作
              ├─ 改状态（情绪/需求/记忆）
              └─ 写事件（event-store.ts）
```

**关键设计**：**LLM 只做决策，不做状态管理**。
状态迁移全在 TypeScript 代码里（`emotion-manager` / `needs-manager` / `memory-manager`），
所以行为**可复现**、可对拍。

这也是阶段 2.5 能做「规则对拍」的前提 —— 规则变了行为一定变，
规则没变行为一定不变（除了 LLM 的随机性）。

---

## 5. 世界生成走过的路

```
npm run create "一个江南水乡的茶馆"
        │
        ▼
orchestrator/src/index.mjs
        │
        ├─▶ world-designer.mjs    LLM 设计世界（名字、区域、角色、互动元素）
        │
        ├─▶ generators/map/       生成地图图片 → 视觉模型定位区域坐标
        │     └─ 产出 map/06-final.tmj
        │
        ├─▶ config-generator.mjs  读 TMJ → 生成 config/world.json
        │     ├─ buildLocations        区域 → 地点
        │     ├─ buildMainAreaPoints   主区域点位
        │     └─ findPrimaryPublicHubRegion  挑「公共枢纽」
        │
        ├─▶ generators/character/  生成角色立绘
        │
        └─▶ 写出 world 目录
              ├── map/06-final.tmj
              ├── config/world.json     ← 世界的权威配置
              ├── config/scene.json
              ├── characters/
              └── world-design.json
```

### TMJ 和 world.json 的分工

这是**最容易搞错**的地方，务必记住：

| | 谁读它 | 它是什么 |
|---|---|---|
| `map/06-final.tmj` | **客户端**（`MapManager`） | 地图的**布局** —— 区域框在哪、什么像素、碰撞网格 |
| `config/world.json` | **服务端**（`WorldManager`） | 世界的**内容** —— 地点、物件、规则、角色状态 |

**两边的地点 id 必须一一对应**，否则会出现「看得见但用不了」的区域 ——
客户端画得出那个框、显示得出它的名字，角色却永远去不了。

这条不变量由 `orchestrator/src/repair-world-locations.mjs` 维护，
它的规则写在文件头部。

---

## 6. 存储布局

```
output/worlds/<worldId>/          ← 生成的世界
├── map/
│   ├── 06-final.tmj              ← 地图布局（客户端读）
│   └── 06-background.png
├── config/
│   ├── world.json                 ← 世界的权威配置（服务端读）
│   ├── scene.json
│   └── model.json
├── characters/
│   ├── characters.json
│   └── <charId>/                  ← 角色立绘 + metadata
├── timelines/<timelineId>/
│   └── snapshots/<snapshotId>/   ← 快照（L3 的基础）
└── world-design.json              ← LLM 最初的设计稿

library/worlds/<worldId>/          ← 手动放进来的世界（同一套布局）
```

**为什么分成 `output/` 和 `library/`**：
`output/` 是生成的（可以随时删），`library/` 是保留的（进版本管理）。

---

## 7. 几个反直觉的地方

### `TILE_SIZE = 32` 是兜底值，不是真的

真实世界的 TMJ 都**显式写了**自己的 `tilewidth` —— 实测是 **4 或 8**。
32 这个默认值**从未生效过**。

改它不会有任何可见变化（也就没有验收信号）。真实格子大小一律从 TMJ 读。

### 中心区域 `main_area` 没有矩形

它由 `mainAreaPoints`（一批点位）定义，不是由一个矩形定义。
点位的范围是整张地图上「非区域地带」的可走空白处。

所以 client 里 main_area **画不出边界**，角色在里面靠 `mainAreaPointId` 寻址，
不靠区域命中。

### 插件钩子没有 `simulate`

插件挂在**生成**流程上（`design` / `generate` / `extendWorldConfig`）。
orchestrator 生成完世界就退出了，跟 core 的模拟引擎是两套生命周期，
插不进 `simulate` 钩子。

模拟期的扩展点应该在 core 或 server 那边。

### 「区域没有 id 怎么办」client 和 orchestrator 不一样

- **client**：跳过 —— 宁可少一个，也不该拿名字当 id
- **orchestrator**：退回用 name —— 生成期要尽量不丢数据

这个差异**是有意的**。解析层（`tmj-parser.ts`）只暴露 `id: null`，
由调用方各自决定。**改兜底规则要改调用方，不改解析层。**

---

## 8. 相关文档

| 文档 | 讲什么 |
|---|---|
| [配置参考](../reference/configuration.md) | world.json / rules / 模型配置 的字段说明 |
| [规则外置指南](../guides/world-rules.md) | 怎么改规则、怎么验证改了真的生效 |
| [插件开发指南](../guides/plugins.md) | 从零写一个插件 |
| [CLI 指南](../guides/cli.md) | 命令行怎么用 |
| `docs/REFACTOR-PLAN.md` | 重构的总体计划与历史 |
| `E:\WordX\workspace\PROJECT.md` | 产品定位与审查基准（**仓库外**） |
