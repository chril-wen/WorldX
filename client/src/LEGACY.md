# client/src 里的遗留门面

阶段 5 把地图数据层搬到了 `packages/client-core`。
下面这些文件**留着路径，但实现已经不在这里了** —— 它们只是 re-export。

## 为什么要留门面

直接改 client 里所有的 import 路径当然也行，但门面能保证：

- **既有 import 路径不破** —— 外部引用、测试、脚本都还能用
- **换实现只改一处** —— 以后要换 A* 库、换 TMJ 解析器，改 client-core 就够，
  client 这边一行不动

跟阶段 1 对 server 的做法一样：`server/src/core/*.ts` 迁到 `packages/core`
之后，server 侧留一层门面。

## 门面清单

| 文件 | 现在是什么 | 实现住在哪 |
|---|---|---|
| `systems/MapManager.ts` | re-export `MapManager` + 类型 | `packages/client-core/src/map-model.ts` |
| `systems/PathfindingManager.ts` | re-export `PathfindingManager` + 类型 | `packages/client-core/src/pathfinding.ts` |
| `config/game-config.ts` | re-export `DEFAULT_CENTER_LOCATION_ID` | `packages/core/src/contracts/world.ts` |
| `types/api.ts` | re-export `LocationInfo` / `MainAreaPointInfo` | `packages/client-core/src/types.ts` |

## 什么时候可以删

等 client 里**所有** import 都改成直接指向 `@worldx/client-core`，
且外部（脚本、测试、文档）也不再引用这些路径的时候。

在那之前不要删 —— 删了就是破坏性变更。

## 依赖怎么解决的

client **不是** npm workspace（`client/`、`server/`、`orchestrator/`、
`generators/` 各自有独立的 `package.json` 和 `node_modules`），
所以不能把 `@worldx/client-core` 写进 `client/package.json` 的 dependencies ——
npm 会去 registry 找，然后 404。

沿用仓库里 `@server-types` 的既有做法：

- `client/vite.config.ts` 里加 alias，指向**源码**
  （`../packages/client-core/src/index.ts`）—— 改 client-core 不需要先 build
- `client/tsconfig.json` 里加 `paths`，同样指向源码

跟 client-core 依赖 `@worldx/core` 的方式不一样：那一侧是真正的
npm workspace 依赖，根目录 `node_modules/@worldx/core` 有符号链接。

## 相关的坑

### `TILE_SIZE = 32` 是兜底值，不是真实格子大小

真实世界的 TMJ 都**显式写了**自己的 `tilewidth` —— 实测是 **4 或 8**，
不是 32。32 这个默认值在真实世界里**从未生效过**。

改它不会有任何可见变化（也就没有验收信号），别改。
真实格子大小一律从 TMJ 的 `tilewidth` 读。

### `easystarjs` 已经从 `client/package.json` 移除了

寻路实现搬到了 client-core，依赖也跟着搬走了。
client 侧不再直接依赖它。
