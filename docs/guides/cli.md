# CLI 指南

> **讲什么**：`worldx` 命令行工具怎么用。
>
> **一句话**：WorldX 的主界面是浏览器，但**有些事在终端里更顺手** ——
> 跑 tick 看事件流、改规则看效果、快照分叉对比。

---

## 1. 跑起来

```bash
npm run cli -- help
```

或者全局装（`apps/cli/package.json` 里声明了 `bin`）：

```bash
worldx help
```

**本文用 `worldx` 指代**。用 `npm run cli --` 也一样：
`npm run cli -- worlds` ≡ `worldx worlds`。

---

## 2. 哪些命令要 server，哪些不要

这是 CLI 最重要的一条区别。

| 命令 | 要 server | 为什么 |
|---|---|---|
| `worlds` `world` `locations` | ❌ | 纯文件系统 —— 读 world.json |
| `rules` `timeline` | ❌ | 纯文件系统 —— 改配置、切快照 |
| `create` | ❌ | 自己 spawn orchestrator |
| `status` `tick` `characters` `events` | ✅ | 状态在 server 内存/数据库里 |

**不需要 server 的命令在 server 没跑的时候照样能用** ——
这是有意的：规则和快照是离线资产，不该因为「没开服务」就动不了。

要 server 的命令在 server 没跑时会**明确告诉你怎么启动**：

```
错误：server 没在跑。tick 需要 server（模拟状态在它内存里）。
先启动：npm run dev:server
```

---

## 3. 命令一览

| 命令 | 干什么 |
|---|---|
| `create "<描述>"` | 生成一个世界（要几分钟） |
| `worlds` | 列出所有世界 |
| `world` | 看一个世界的详情 |
| `locations` | 列出地点 + 检查 TMJ/world.json 一致性 |
| `status` | 看模拟当前状态 |
| `tick` | 推进一个 tick（`--count N` 推进多个） |
| `characters` | 列出角色和他们在干什么 |
| `events` | 看事件流 |
| `rules` | 看 / 改世界规则 |
| `timeline` | 快照 / 分叉 / 对比 |

### 通用选项

| 选项 | 作用 |
|---|---|
| `--world <id\|路径>` | 指定世界（默认：最近生成的那个） |
| `--json` | 输出 JSON（给脚本用） |
| `--help` | 显示帮助 |

---

## 4. 常用流程

### 4.1 生成世界，然后看它

```bash
worldx create "一个江南水乡的茶馆"
worldx worlds
worldx world
worldx locations
```

`worldx locations` 会顺手做一件有用的事：**对比 TMJ 和 world.json 的地点 id**。
两边对不上就报出来 —— 这就是「看得见但用不了」的那个坑。

```
一致性检查
───────
  ✓ TMJ（10）与 world.json（11）一致（中心区域例外）
```

（中心区域由 `mainAreaPoints` 定义、没有矩形，所以 TMJ 里没有它的 region ——
这是设计如此，不是问题。）

### 4.2 跑 tick，看发生了什么

```bash
# server 得在跑
npm run dev:server

worldx status
worldx tick
worldx characters
```

`tick` 的输出：

```
推进了 1 个 tick
──────────────
  世界    world_2026-10-24T16-41-22
  时间线   tl-20261026-081913
  当前时间  第 1 天 戌时正 (19:30)（晚上）
  事件数   2

事件
────
  赵龙 → 林哲：「做买卖？卖什么，落脚在哪儿？」
  林哲 → 赵龙：「卖些……针头线脑的小玩意儿。刚进城，还没寻着落脚的地儿……」
```

跑多个：

```bash
worldx tick --count 10
```

### 4.3 看事件流

```bash
worldx events --limit 20
worldx events --type dialogue
worldx events --actor char_1792860223221
worldx events --from-day 2 --to-day 3
```

### 4.4 改规则，验效果

```bash
worldx rules list                        # 看有哪些规则
worldx rules show                        # 看当前值
worldx rules set emotion.decayRate 0.9   # 改
curl -X POST http://localhost:3100/api/world/reload
```

改完**必须 reload** —— server 的规则是启动时读进内存的。
验证流程见 [规则外置指南](world-rules.md)。

### 4.5 快照、分叉、对比

这是 L3（世界可控）的核心能力。

```bash
worldx timeline list                              # 列出时间线
worldx timeline snapshots <timelineId>            # 列出快照
worldx timeline snapshot <timelineId> --desc "分岔点"
worldx timeline fork <timelineId> <snapshotId> --label "另一种可能"
worldx timeline diff <timelineA> <timelineB>     # 对比
```

`timeline` 是**转发**给 `scripts/timeline.mjs` 的 —— 快照和分叉是纯文件操作，
不依赖 server 在跑。

---

## 5. 给脚本用

加 `--json` 就输出纯 JSON：

```bash
worldx tick --json | jq '.events[] | select(.type == "dialogue")'
worldx worlds --json | jq '.worlds[] | .id'
worldx characters --json
```

**两种格式从同一份数据生成** —— 不会出现「表格里有的字段 JSON 里没有」。

---

## 6. 服务器地址

默认连 `http://localhost:3100`。换地址用环境变量：

```bash
WORLDX_SERVER=http://192.168.1.10:3100 worldx status
```

---

## 7. 代码在哪

```
apps/cli/
├── src/
│   ├── index.mjs            入口：分发 + 帮助
│   ├── commands/
│   │   ├── index.mjs        命令表
│   │   ├── create.mjs       生成世界
│   │   ├── worlds.mjs       列出世界
│   │   ├── world.mjs        世界详情
│   │   ├── locations.mjs    地点 + 一致性检查
│   │   ├── status.mjs       模拟状态
│   │   ├── tick.mjs         推进 tick
│   │   ├── characters.mjs   角色
│   │   ├── events.mjs       事件流
│   │   ├── rules.mjs        → 转发 scripts/rules.mjs
│   │   ├── timeline.mjs     → 转发 scripts/timeline.mjs
│   │   └── help.mjs         帮助
│   └── lib/
│       ├── args.mjs         参数解析
│       ├── format.mjs       输出格式
│       ├── api-client.mjs   HTTP 客户端
│       ├── world-paths.mjs  世界寻址（跟 scripts/ 共用）
│       ├── core-loader.mjs  加载 core 的 TS
│       ├── event-render.mjs 事件渲染
│       └── name-maps.mjs    id → 名字
└── test/cli.test.mjs
```

**命令是动态加载的** —— 只有真正用到某个命令才会 import 它，
所以 `worldx help` 不会加载所有命令的依赖。

---

## 相关文档

- [架构总览](../architecture/overview.md) —— CLI 在运行时哪里
- [规则外置指南](world-rules.md) —— 改规则 + 验证
- [配置参考](../reference/configuration.md) —— world.json 字段
