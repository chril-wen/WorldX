# 配置参考

> **讲什么**：`world.json` 的每个字段是什么意思、能改成什么、
> 哪些改了**不生效**（这是最容易踩坑的地方）。
>
> **权威处**：`packages/core/src/contracts/world.ts` 是类型的定义处。
> 本文说的是**语义**。

---

## 1. 三个配置文件

| 文件 | 谁读 | 改它干嘛 |
|---|---|---|
| `config/world.json` | **服务端** | 世界的内容：地点、物件、规则、角色 |
| `map/06-final.tmj` | **客户端** | 地图的布局：区域框在哪、碰撞网格 |
| `config/model.json` / `server/config/models.json` | 服务端 | 用哪个模型、调什么参数 |

**world.json 和 TMJ 的地点 id 必须一一对应** —— 否则会出现
「看得见但用不了」的区域（客户端画得出框，服务端不认识）。
见 `orchestrator/src/repair-world-locations.mjs` 的规则。

---

## 2. world.json 顶层

```jsonc
{
  "schemaVersion": 2,              // 配置结构版本 —— 决定要不要迁移
  "centerLocationId": "main_area", // 世界的公共枢纽（见 §3）

  "worldName": "江南水巷",
  "worldDescription": "……",
  "worldSocialContext": "……",
  "contentLanguage": "zh",
  "originalPrompt": "用户最初的那句话",

  "scene": { /* §4 */ },
  "worldActions": [ /* §5 */ ],
  "locations": [ /* §3 */ ],
  "mainAreaPoints": [ /* §6 */ ],
  "worldSize": { /* §7 */ },

  "weather": null,                 // 天气配置
  "hearsay": { "enabled": true },  // 传闻系统开关

  "metadata": { /* 设计稿的存档，通常不用管 */ }
}
```

---

## 3. 地点 `locations`

```jsonc
{
  "id": "riverside_tea_shed",     // 唯一 id —— 要跟 TMJ 的 region id 对上
  "name": "临河茶棚",
  "description": "沿河搭建的简易茶棚。",
  "adjacentLocations": ["main_area", "water_lane_stone_bridge"],
  "objects": [ /* §3.2 */ ],
  "indoor": false                 // 可选 —— true = 室内（不受天气影响）
}
```

### 3.1 `centerLocationId` 与中心区域

`centerLocationId` 指向的那个地点是**世界的公共枢纽**。

**它没有矩形** —— 由 `mainAreaPoints`（一批点位）定义，不是由一个框定义。
所以客户端**画不出它的边界**，角色在里面靠 `mainAreaPointId` 寻址。

`adjacentLocations` 是**单向声明**就够 —— 归一化时
`normalizeLocations()` 会把中心区域连到所有其它区域，
并给每个区域补上到中心的连接。

### 3.2 物件 `objects`

```jsonc
{
  "id": "tea_counter",             // 唯一 id
  "name": "曲尺柜台",
  "locationId": "main_area",
  "defaultState": "available",
  "capacity": 2,                   // 同时能有几个角色在用
  "interactions": [
    {
      "id": "order_tea",
      "name": "点一壶茶",
      "description": "向掌柜点茶，顺便要一碟瓜子或点心。",
      "availableWhenState": ["available"],
      "duration": 1,               // 占几个 tick
      "effects": [ /* §5.2 */ ],
      "repeatable": true,          // 能不能重复做
      "requiresAnchor": true       // 需要一个「站位」才能做
    }
  ]
}
```

---

## 4. 场景 `scene`

```jsonc
{
  "sceneType": "closed",           // closed / open
  "startTime": "08:00",
  "tickDurationMinutes": 30,       // 一个 tick 多少分钟
  "maxTicks": 48,                  // 一天多少 tick
  "displayFormat": "HH:mm",
  "description": "……",
  "multiDay": {
    "enabled": true,
    "endOfDayText": "……",
    "newDayStartTime": "07:00"
  }
}
```

---

## 5. 世界动作 `worldActions`

角色**没有具体物件可交互**时可以做的通用动作。

```jsonc
{
  "id": "share_table_chat",
  "name": "拼桌闲谈",
  "description": "端茶坐到有人的桌边，借茶水闲聊试探。",
  "availableWhenState": ["available"],
  "duration": 3,
  "effects": [ /* §5.2 */ ],
  "repeatable": true
}
```

### 5.2 效果 `effects`

| type | 字段 | 做什么 |
|---|---|---|
| `character_need` | `target`, `value` | 改角色的某个需求值 |
| `character_emotion` | `target`, `value` | 改角色情绪（效价/唤醒） |
| `world_state` | `target`, `value` | 改世界全局状态 |
| `character_memory` | `target`, `value` | 写进角色记忆 |
| `object_state` | `target`, `value` | 改物件状态（如 `"low"`） |
| `consume_item` | `target`, `amount` | 消耗物品库存 |
| `restock_item` | `target`, `amount` | 补货 |

> 前四个在 `Effect` 类型里（`packages/core/src/contracts/world.ts`），
> 后三个是 `plugins/economy.ts` 引入的**扩展类型** ——
> `action-executor.ts` 认它们，但契约里没声明，所以要用的话得自己加类型。

### ⚠️ `character_need` 的 target 只有一个真的生效

**当前 core 只实现了 `curiosity` 这一个需求维度。**

`target` 写别的名字（比如 `thirst`、`relaxation`、`belonging`）
**不会报错，但也不会生效** —— 状态存储是白名单式的，
不认识的字段直接丢弃。

实测一个真实世界里有 16 个 `character_need` 效果，
其中 **8 个的 target 是 `curiosity`（生效）**，另外 8 个
（`thirst` / `relaxation` / `belonging`）是 LLM 生成时自造的，**静默失效**。

> **这是设计遗留**，不是 bug —— 「多维需求」写在核心定位里，
> 但只落地了 `curiosity` 一维。
> 要加维度：改 `packages/core/src/contracts/character.ts` 的 `CharacterState`、
> `server/src/store/character-state-store.ts` 的列映射、
> `packages/core/src/engine/needs-manager.ts` 的衰减逻辑。

---

## 6. 主区域点位 `mainAreaPoints`

```jsonc
{
  "id": "main_area_point_1",
  "name": "主区域点位1",
  "x": 1038,                       // 像素坐标
  "y": 702,
  "adjacentPointIds": ["main_area_point_19"]  // 走得到的其它点位
}
```

**邻接关系是可达性** —— 服务端靠它判断「两个点位之间能不能走过去」。
没有邻接关系，角色会觉得哪儿也去不了。

---

## 7. 地图尺寸 `worldSize`

```jsonc
{
  "width": 3200,       // 像素宽
  "height": 1360,      // 像素高
  "tileSize": 4,       // ⚠️ 真实世界的格子是 4 或 8，不是 32
  "gridWidth": 800,    // = width / tileSize
  "gridHeight": 340
}
```

> **`tileSize` 别想当然**。代码里的 `TILE_SIZE = 32` 是**从没生效过的兜底值** ——
> 每个世界的 TMJ 都显式写了自己的 `tilewidth`（实测 4 或 8）。
> 这个字段是**推断出来的**，不是配置的。

---

## 8. 世界规则 `rules`

规则**在 world.json 里**（`rules` 段），不在代码里。这是「世界可控 L2」的基础。

```jsonc
{
  "rules": {
    "emotion": {
      "valenceCurrentWeight": 0.7, "valenceEventWeight": 0.3,
      "arousalCurrentWeight": 0.8, "arousalEventWeight": 0.2,
      "valenceMin": -5, "valenceMax": 5,
      "arousalMin": 0, "arousalMax": 10,
      "arousalBaseline": 3,
      "decayRate": 0.95,
      "strongValenceThreshold": 2, "strongArousalThreshold": 6,
      "mildArousalThreshold": 3, "boredArousalThreshold": 1
    },
    "needs": {
      "baseDecay": 0.5, "strenuousExtraDecay": 0.5, "intuitionCoefficient": 1
    },
    "memory": {
      "relevanceWeight": 3, "recencyWeight": 2, "importanceWeight": 2,
      "emotionalIntensityWeight": 1, "recencyDecayRate": 0.05,
      "relatedCharacterBonus": 0.3, "relatedLocationBonus": 0.2,
      "accessStrengthBonus": 0.5,
      "deleteDecayFactor": 0.1, "deleteAfterDays": 7,
      "fadeDecayFactor": 0.3, "fadeAfterDays": 3,
      "faintStrengthThreshold": 3, "faintAfterDays": 5,
      "consolidateImportance": 6, "consolidateAccessCount": 3,
      "referencedDecayFactor": 0.3
    },
    "perception": {
      "visibleValenceThreshold": 2, "visibleArousalThreshold": 7
    },
    "action": {
      "longActionMinutes": 60
    }
  }
}
```

一共 **37 个参数**，分 5 组。

> **有些世界的 world.json 里还没有 `rules` 段** —— 那表示
> 「全部用默认值」。跑 `npm run rules -- show` 会看到提示：
> `（world.json 里还没写 rules 段 —— 现在用的全是默认值）`。
> 改第一条规则时它会被自动创建。

**完整的规则清单、默认值和取值范围**：

```bash
npm run rules -- list
```

**改规则的正确姿势**见 [规则外置指南](../guides/world-rules.md)。

---

## 9. 角色配置

角色配置在**世界目录的 `config/characters/<charId>.json`**（每个角色一个文件），
另有 `characters/characters.json` 是一份**摘要清单**（id / name / description），
`characters/<charId>/metadata.json` 是**立绘的动画帧信息**。

**真正被运行时读的是 `config/characters/<charId>.json`**：

```jsonc
{
  "id": "char_1792494562655",
  "name": "沈四娘",
  "role": "茶馆掌柜",
  "personality": "精明周到，善于察言观色……",
  "appearanceHint": "她肩上搭着白布巾……",

  "motivation": "守住这间水巷口的茶馆……",
  "coreValues": ["……"],              // 可选
  "speakingStyle": "……",              // 可选
  "fears": ["……"],                    // 可选

  "socialStyle": "ambivert",
  "extraversionLevel": 0.5,
  "intuitionLevel": 0.7,               // 影响需求衰减速度

  "skills": ["……"],
  "writeDiary": true,
  "fourthWallCandidate": false,
  "tags": ["……"],

  "startPosition": {                   // 初始位置
    "type": "region",                  // region / main_area / point
    "targetId": "riverside_tea_shed",
    "locationId": "main_area",
    "mainAreaPointId": "element_tea_counter"
  },

  "initialMemories": [                 // 开局就有的记忆
    { "type": "reflection", "content": "……", "importance": 6, "tags": ["background"] }
  ],

  "affinity": 2,                       // 与他人的平均亲近度（0-5）
  "tension": 0,                        // 与他人的平均紧张度（0-5）

  "rules": {                           // 角色级规则 override
    "emotion": { "decayRate": 0.8 }
  }
}
```

字段的权威定义在 `packages/core/src/contracts/character.ts` 的
`CharacterProfile`。**注意 `startPosition` 有两种形态**：
字符串，或者 `{ locationId }` / `{ type, targetId }` 对象。

### 改名会静默出问题

「世界中心改名」要同时改三处：
world.json 的 `centerLocationId` + locations 的 id + 角色配置的 `startPosition`。
错一处角色就落在不存在的地方，**不报错**。

> 注意 `characters/characters.json`（摘要清单）**不是运行时读的** ——
> 改它不影响模拟，只影响某些列表显示。

---

## 10. 改配置的安全姿势

| 你要改 | 用什么 | 会不会立刻生效 |
|---|---|---|
| 规则 | `npm run rules -- set <path> <value>` | ❌ 要 reload |
| 地点/物件 | 直接改 world.json | ❌ 要 reload |
| 角色 | 改 `characters/*.json` | ❌ 要 reload |

**reload**：

```bash
curl -X POST http://localhost:3100/api/world/reload
```

**改完必须验证**，别假设它生效了。规则改动的验证流程见
[规则外置指南](../guides/world-rules.md)。

---

## 相关文档

- [架构总览](../architecture/overview.md) —— 这些配置在运行时的位置
- [规则外置指南](../guides/world-rules.md) —— 改规则 + 验证
- [CLI 指南](../guides/cli.md) —— 命令行操作
