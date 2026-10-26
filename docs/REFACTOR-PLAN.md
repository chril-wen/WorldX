# WorldX 重构方案

> **历史文档** —— 这里写的是重构**开始时**的计划，用的还是原名 "WorldX"。
> 项目现名 **OWN-World**（2026-10-26 重命名）。
> 计划的**当前状态**见 `E:\WordX\OWN-World-design\product\ROADMAP.md`。
>
> 目标：把 WorldX 从「一个具体的成品项目」改造成「一个自己方便开发、扩展的完整产品」。
> 方式：原地重构、分步提交；插件式 + 配置驱动双轨扩展。
> 本地操作，不推远程。

---

## 一、现状体检

### 1.1 资产盘点

| 模块 | 规模 | 价值判断 |
|---|---|---|
| `server/src/simulation/` | 6 文件 2500 行 | **核心资产**。引擎干净：只依赖 `WorldManager`/`CharacterManager` 接口 + `store/*`，不碰 Express |
| `server/src/core/` | 7 文件 2700 行 | **核心资产**。`world-manager` 1210 行是数据模型中枢 |
| `server/src/store/` | 7 文件 1038 行 | 可用，但 SQLite 直接开在 `db.ts` |
| `generators/` | 52 文件 9500 行 | **核心资产**。地图生成管线 + 角色立绘，多步审查循环 |
| `orchestrator/` | 12 文件 5600 行 | **核心资产**。世界设计 → 配置生成 → 调用生成器 |
| `client/src/scenes` + `systems` | 3400 行 | Phaser 地图渲染 + 寻路 + 回放，耦合 TMJ 格式 |
| `client/src/ui` | 6100 行 | **最可能砍的部分**。`CreateWorldPage` 一个文件 1268 行 |
| `server/src/api` | 10 路由 | 47 个 API 方法，Express 胶水层 |

**总计约 39000 行 TypeScript/mjs，MIT 许可，可自由改造和商用。**

### 1.2 三个真实痛点

**痛点 A：配置层没有单一入口。**
现在配置散落在四处：`server/configs/prompts/`（10 个提示词）、`orchestrator/prompts/`（1 个，**同名不同内容**）、`generators/*/prompts/`（11 个）、`.env`（4 组模型配置）。
后果：
- 想改一个提示词要跨 3 个目录找
- `design-world.md` 有两份，改错哪份都不确定
- 加一种新模型 provider 要改代码（`gemini-pro.mjs`、`gemini-flash-img.mjs` 里硬编码 env key）

**痛点 B：没有扩展点，一切都是硬编码流程。**
`orchestrator/src/index.mjs` 是一条固定直线：
```
designWorld → configGenerator → runNodeScript(map) → runNodeScript(character)
```
想加一个新阶段（比如「生成派系关系」「生成建筑蓝图」）必须改 `index.mjs`。
`server/src/api/routes/expand.ts` 同理——写死了 spawn orchestrator 的路径和参数格式。

**痛点 C：世界特定的假设渗进了代码。**
`main_area` 这个字面量在 `server/src` 出现 **55 次**。它本该是「世界的中心区域」这个概念，却硬编码成了具体 id。
`world-manager.ts:80` 甚至把 `worldName ?? "main_area"` 当兜底值——世界名和区域 id 混为一谈。

### 1.3 已经做对的地方（要保留）

- **模拟引擎分层干净**：`simulation-engine.ts` 1239 行，通过接口访问状态，SQLite 只在 `store/*` 层碰。这是能抽出独立包的关键。
- **`shared/structured-output.mjs`**：LLM 结构化输出解析，跨服务共享。
- **地图生成的多步审查循环**：`step1 → review → step3 → step3.2 → step4 → review`，带人工确认点。这套流程设计得很好。
- **TMJ 作为地图格式**：Tiled 生态，客户端用 `MapManager` 解析。
- **扩图 outpainting**（本次会话新做的）：四方向 + 分块定位 + 去重，已验证。

---

## 二、目标架构

```
worldx/
├── packages/
│   ├── core/          # ← 新增：引擎内核，无框架依赖
│   │   ├── engine/    #   simulation + core（WorldManager/CharacterManager/Memory）
│   │   ├── contracts/ #   所有接口定义（World, Character, Engine, Storage）
│   │   └── index.ts
│   ├── generators/    # ← 从 generators/ 迁入，加插件注册表
│   │   ├── map/
│   │   ├── character/
│   │   └── registry.ts
│   ├── protocol/      # ← 新增：TMJ / world.json 的读写与校验
│   └── client-core/   # ← 新增：Phaser 无关的地图数据层
├── apps/
│   ├── server/        # ← 从 server/ 迁入，只做 HTTP 胶水
│   ├── client/        # ← 从 client/ 迁入
│   └── cli/           # ← 新增：开发用命令行
├── prompts/           # ← 统一：所有提示词一个目录，按能力分文件
├── plugins/           # ← 新增：本地插件（示例放 ark-provider、自定义生成器等）
├── worlds/            # ← 统一：library/ 和 output/ 合流
└── docs/
```

### 2.1 插件机制（核心）

**目标**：加一个新功能 = 写一个文件 + 一行注册，**不改任何现有代码**。

```ts
// packages/core/src/contracts/index.ts
export interface WorldPlugin {
  name: string;
  version?: string;
  /** 世界设计阶段：这个插件产出什么 */
  design?(ctx: DesignContext): Promise<DesignContribution>;
  /** 生成阶段：这个插件要跑什么 */
  generate?(ctx: GenerateContext): Promise<GenerateResult>;
  /** 模拟阶段：这个插件要不要参与每个 tick */
  simulate?(ctx: TickContext): void | Promise<void>;
  /** 扩展 world.json 的顶层字段 */
  extendWorldConfig?(config: WorldConfig): void;
}
```

```ts
// packages/generators/src/registry.ts
export function registerProvider(name: string, provider: ImageProvider): void;
export function registerPipeline(name: string, pipeline: GenerationPipeline): void;
```

**内置 provider 全部改为插件**：`ark-seedream`、`openai-images`（kemuapi）、`gemini`、`openai-compatible` 变成注册表里的条目，而不是 `if (provider === "xxx")` 的分支。

**本地插件示例**（`plugins/` 目录，无需改核心代码）：
```ts
// plugins/my-provider.ts
registerProvider("my-image-api", {
  async generate(prompt, opts) { /* ... */ },
});
```

### 2.2 配置驱动

**统一提示词目录**：所有 `.md` 提示词移到 `prompts/<能力>/<名字>.md`，用 `{{变量}}` 占位。
- 现在 `design-world.md` 有两份 → 合并成一份
- 提示词可被插件覆盖：`plugins/` 里的同名文件优先

**统一模型配置**（`.env` → `config/models.json`）：
```json
{
  "roles": {
    "orchestrator": { "provider": "openai-compatible", "baseUrl": "...", "model": "...", "timeoutMs": 120000 },
    "vision":       { "provider": "ark", "baseUrl": "...", "model": "...", "timeoutMs": 240000 },
    "image":        { "provider": "openai-images", "baseUrl": "...", "model": "..." },
    "simulation":   { "provider": "openai-compatible", "baseUrl": "...", "model": "..." }
  }
}
```
`.env` 仍支持，但作为覆盖层——方便现有开发习惯。

**管线配置**（`config/pipeline.json`）：决定世界生成跑哪些阶段、什么顺序。
```json
{
  "design": ["core", "weather", "economics"],
  "generate": ["map", "character"],
  "plugins": ["plugins/my-provider.ts"]
}
```

### 2.3 消除 `main_area` 硬编码

引入**世界语义常量**：
```ts
// packages/core/src/contracts/world.ts
export const WORLD_CENTER = "main_area";  // 集中一处，全局引用
```
更彻底的做法是让 `main_area` 成为 world.json 的一个**声明式字段**（`world.centerLocationId`），代码不再假设它的字面值。55 处替换成读配置。

### 2.4 world.json 版本化

```ts
// packages/core/src/contracts/world.ts
export const WORLD_SCHEMA_VERSION = 2;

export interface WorldConfig {
  schemaVersion: number;   // 缺失时视为 1
  worldName: string;
  centerLocationId: string; // 替代散落的 main_area 硬编码
  // ...
}

export function migrateWorldConfig(raw: unknown): WorldConfig {
  // v1 → v2：补 schemaVersion、centerLocationId
}
```

迁移函数放在 `packages/core`，server 和 orchestrator 共用，读到旧 world.json 自动升级后再处理。

---

---

## 三、分阶段实施

每个阶段独立可运行、可回退、独立提交。

### 阶段 0：建立保护网（3-5 天）
**目标**：重构前先有测试网，否则改不动。

- 装 vitest（全仓统一，替代零散的自检脚本）
- server core 单测：Memory / Needs / Emotion / Decision / Perception / ActionExecutor
- client 单测：`MapManager`、`PathfindingManager`（**这两个不依赖 Phaser，是纯逻辑**）、`event-format`、`time-i18n`、`time-sync`、`library-world-sort`
- 保留并迁移 `expand-map.selfcheck.mjs` 为 vitest 用例
- 加 `npm run check` = 类型检查 + 单元测试 三合一
- **不改任何业务逻辑**

> client 测试范围已确认包含。Phaser 相关代码（`WorldScene`、`CharacterMovement`）不做单测，靠手动冒烟。

**产出**：`npm run check` 一条命令验证全仓健康。

### 阶段 1：抽出 `packages/core`（3-5 天）
**目标**：模拟引擎变成无框架依赖的库，server 变成薄壳。

- 建 `packages/core`，把 `server/src/core/` + `server/src/simulation/` 搬进去
- 把接口抽到 `packages/core/src/contracts/`
- `Storage` 抽象：把 `store/*` 的 SQLite 实现改成实现 `Storage` 接口的 adapter
- server 的 `WorldManager` 等改为从 core 导入并重新导出（保持现有 import 路径不破）
- 新增 `packages/core/test/` 单测

**验收**：`npm run check` 通过；server 现有 API 全部不变；client 不受影响。

### 阶段 2：统一配置层（2-3 天）
**目标**：一个地方改配置，加 provider 不改代码。

- 建 `prompts/` 统一目录，迁移 22 个提示词文件
- 解决 `design-world.md` 双份问题
- 建 `config/models.json`，`.env` 降级为覆盖层
- 写 `packages/core/src/llm/provider-registry.ts`
- 把 `gemini-pro.mjs` / `gemini-flash-img.mjs` 里硬编码的 env key 换成注册表查找

**验收**：换 provider 只改 JSON；改提示词只改 `prompts/` 下的 md。

### 阶段 3：插件机制（3-5 天）
**目标**：加功能不改核心代码。

- 定义 `WorldPlugin` 接口和生命周期钩子
- `orchestrator` 管线改成「阶段注册表 + 配置文件驱动顺序」
- 现有能力（地图生成、角色生成、天气、经济）注册成内置插件
- `plugins/` 目录加载本地插件
- 写一个示例插件（比如「生成派系关系」）证明扩展点可用

**验收**：新增一个插件文件即生效，无需改 `orchestrator/src/index.mjs`。

### 阶段 4：清理世界硬编码（2-3 天）
**目标**：`main_area` 不再散落 55 处。

- world.json 加 `centerLocationId` 字段
- 引入 `WORLD_CENTER` 常量或配置读取
- 逐步替换 55 处引用
- `world-manager.ts:80` 的 `worldName ?? "main_area"` 修掉

**验收**：`grep -rn "main_area" server/src packages/ | wc -l` 显著下降；改名测试通过。

### 阶段 5：client 重构（5-10 天）
**目标**：UI 层完全重写，引擎与地图数据层不动。

**已确认：UI 层要完全重写。** 阶段 5 的重点因此变成「把可复用的部分保护好」，而不是「改造现有 UI」。

- `packages/client-core/`：把 `MapManager`（695 行）+ `PathfindingManager`（412 行）搬进去
  —— 这两个已确认**不依赖 Phaser**，是纯逻辑，可直接测、可被任何前端复用
- `packages/client-core/` 补齐：TMJ 解析、区域查询、walkable 网格、坐标换算
- `client/src/scenes/WorldScene.ts`（924 行）里的地图装载逻辑迁到 client-core
- 现有 UI 面板（`client/src/ui/` 6100 行）**标记为 legacy**，不再投入
- 新 UI 在 `apps/client-new/` 起，不受旧代码约束
- 旧 client 保持可运行，直到新 UI 就绪再切

**验收**：新 UI 只依赖 `packages/client-core` + server API，能独立渲染地图并驱动角色；旧 client 不受影响。

### 阶段 6：工具链与文档（2 天）
- `apps/cli`：命令行生成世界、看状态、跑 tick
- 开发文档：架构图、插件开发指南、配置参考
- 保留 MIT LICENSE 和原作者致谢

## 四、工作区与分支策略

```
main                    # 始终可运行
└── refactor/phase-N    # 每个阶段一个分支，合入 main
```

**每阶段的提交流程**：
1. 在 `refactor/phase-N` 上开发
2. `npm run check` 全绿
3. 提交（单功能粒度）
4. 合入 main，跑一次完整冒烟（生成世界 + 跑 tick）
5. 保留分支直到阶段验收通过

**不推远程**，全部留在本地。

---

## 五、风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 重构中把功能改坏 | 高 | 阶段 0 先建测试网；每阶段独立提交；每阶段冒烟 |
| 抽包引入循环依赖 | 中 | `contracts` 层不放任何实现；core 不依赖任何 app |
| 插件机制设计过度 | 中 | 先只支持「设计阶段 + 生成阶段 + 配置覆盖」三类钩子，够用再加 |
| 提示词迁移改变行为 | 中 | 迁移时逐字节比对；用现有世界做回归 |
| client 重构量太大 | 中 | 阶段 5 单独排期，前面阶段不受影响 |

---

## 六、第一阶段的具体任务清单

阶段 0 + 阶段 1 起步（约 1 周）：

- [ ] 建 `packages/core/package.json`（ESM，TS 源码直接引用，走 tsx/tsc）
- [ ] 建 `packages/core/src/contracts/`：World / Character / Engine / Storage 接口
- [ ] 迁移 `server/src/core/{emotion,needs,memory}-manager.ts` → `packages/core/src/engine/`（这 3 个最独立，先搬）
- [ ] 补这 3 个模块的单测
- [ ] 建 `npm run check` 脚本
- [ ] 迁移 `world-manager.ts` / `character-manager.ts`（依赖多，放后）
- [ ] `store/*` 抽象成 `Storage` 接口 + SQLite adapter
- [ ] server 侧改为 re-export，保持 import 路径兼容
- [ ] 全量冒烟：生成一个世界 + 跑 10 个 tick

---

## 七、已确定的决策

| 决策项 | 结论 | 影响 |
|---|---|---|
| 测试范围 | **core + client 都要** | 阶段 0 扩到 3-5 天，装 vitest。client 测 `MapManager`/`PathfindingManager` 等纯逻辑，Phaser 代码靠手动冒烟 |
| Phaser | **UI 层完全重写** | 阶段 5 重点变为「保护可复用部分」。`MapManager`+`PathfindingManager` 提到 `packages/client-core/`；旧 UI 标记 legacy 不再投入 |
| 插件形态 | **TypeScript 文件** | 实现 `WorldPlugin` 接口。配置类的改动（换提示词/换模型）走 `config/`，不占插件位 |
| world.json | **加版本 + 迁移函数** | 加 `schemaVersion` 字段 + `migrateWorldConfig()`，旧世界自动升级 |

### 仍然待定

- 新 UI 用什么技术栈（React 继续？Vue？Svelte？）——不影响前 5 个阶段
- `packages/` 用 npm workspaces 还是 pnpm——阶段 1 开工前定即可
