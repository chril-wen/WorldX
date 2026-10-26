# 开发文档

> **目标读者**：要改 OWN-World 的人 —— 无论是接手某个模块，
> 还是想加一条规则、一个命令、一个插件。
>
> **怎么用这一份**：按你要做的事跳。
> 「我要改 X」→ 查下面那张表 → 跳到对应文档。

---

## 按「我要改什么」找

| 我要改… | 去哪 | 关键文件 |
|---|---|---|
| **地图上画的东西**（区域框、碰撞、可交互物） | [配置参考](reference/configuration.md) | `map/06-final.tmj` |
| **世界的内容**（地点、物件、角色、规则） | [配置参考](reference/configuration.md) | `config/world.json` |
| **角色怎么决策、怎么对话** | [架构总览 §4](architecture/overview.md#4-一次模拟-tick-走过的路) | `packages/core/src/simulation/` |
| **加一个世界动作**（通用交互） | [配置参考 §5](reference/configuration.md#5-世界动作-worldactions) | `config/world.json` 的 `worldActions` 段 |
| **情绪 / 需求 / 记忆的算法** | [架构总览 §3](architecture/overview.md#3-模块地图) | `packages/core/src/engine/` |
| **规则数值** | [规则外置指南](guides/world-rules.md) | `packages/core/src/engine/rules.ts` |
| **世界生成流程** | [架构总览 §5](architecture/overview.md#5-世界生成走过的路) | `orchestrator/src/index.mjs` |
| **命令行** | [CLI 指南](guides/cli.md) | `apps/cli/` |
| **加一个插件** | [插件开发指南](guides/plugins.md) | `plugins/` |
| **UI 面板** | [架构总览 §3](architecture/overview.md#3-模块地图) | `client/src/ui/` |
| **游戏画面 / 角色移动** | [架构总览 §3](architecture/overview.md#3-模块地图) | `client/src/scenes/` `client/src/systems/` |

---

## 四篇主文档

### [架构总览](architecture/overview.md)

**什么时候读**：第一次接触这个仓库；或者你不确定某个改动该落在哪一层。

讲什么：
- 依赖方向（**不可违反的三条**）
- 模块地图
- 一次模拟 tick 走过的路 / 一次世界生成走过的路
- 存储布局
- 几个**反直觉**的地方（`TILE_SIZE = 32` 从没生效过、
  中心区域没有矩形、插件钩子没有 `simulate`……）

### [配置参考](reference/configuration.md)

**什么时候读**：你要改 `world.json`，或者要搞清楚「改了为什么不生效」。

讲什么：
- 每个字段的语义
- **哪些改了不生效**（比如 `character_need` 的 target
  只有 `curiosity` 真的起作用）

### [规则外置指南](guides/world-rules.md)

**什么时候读**：你要调世界的数值（情绪衰减、记忆权重、需求衰减）。

讲什么：
- 规则在哪、怎么改
- **怎么验证改了真的生效**（最重要的一节）

### [插件开发指南](guides/plugins.md)

**什么时候读**：你要在世界生成流程里加一段自定义逻辑。

讲什么：
- 三个钩子、完整例子、错误隔离、顺序与开关
- 照着 §3 抄一遍就能跑

### [CLI 指南](guides/cli.md)

**什么时候读**：你要用命令行操作世界，或者要改 CLI。

讲什么：
- 命令一览、哪些要 server
- 常用流程（生成 → 跑 tick → 改规则 → 快照分叉）

---

## 其它

| 文档 | 讲什么 |
|---|---|
| [EXPERIENCE.md](EXPERIENCE.md) | 阶段 6 的**逐点体验清单** —— 验收时照着走 |
| [ATTRIBUTION.md](ATTRIBUTION.md) | 许可证、作者归属、第三方依赖 |
| [REFACTOR-PLAN.md](REFACTOR-PLAN.md) | 重构的总体计划与历史 |
| `E:\WordX\OWN-World-design\PROJECT.md` | 产品定位与审查基准（**仓库外**） |

---

## 文档的规矩

写文档时守住这几条：

1. **断言要核过代码** —— 写「X 的字段是 Y」之前，先 `grep` 一遍。
   文档里写错的字段比没有文档更糟。
2. **写「不生效」的坑** —— 这类信息最难自己发现，
   但对读文档的人最值钱。
3. **说清为什么** —— 「为什么这个字段是白名单式的」比
   「这个字段是白名单式的」有用得多。
