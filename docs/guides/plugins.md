# 插件开发指南

> **目标读者**：没写过 OWN-World 插件的人。
> 读完这一份你应该能**在半天内**写出一个能用的插件。
>
> **验收标准**：照着 [§3 完整例子](#3-完整例子)抄一遍，放进 `plugins/` 就能生效。

---

## 1. 插件是什么

**一个插件就是一个对象**，带一个 `name`，以及若干个「钩子」。
钩子按阶段分组 —— 你实现哪个就参与哪个阶段，**没实现的阶段直接跳过**，
不用写空函数。

```
plugins/
  README.md      ← 这个文件
  economy.ts     ← 示例插件（物品/经济）
  你的插件.ts     ← 放这儿就生效
```

**放进 `plugins/` 目录就生效** —— 不用改 `orchestrator/src/index.mjs` 任何一个字，
也不用改 `config/plugins.json`。

---

## 2. 三个钩子

| 钩子 | 什么时候跑 | 你拿到什么 | 你返回什么 |
|---|---|---|---|
| `design` | LLM 设计完世界之后 | `worldDesign` | 改过的 `worldDesign` |
| `generate` | 素材生成阶段 | `worldDesign` | 改过的 `worldDesign`（一般不改） |
| `extendWorldConfig` | 生成 world.json 之前 | `{ worldConfig, characterConfigs, sceneConfig }` | 改过的配置包 |

### 参数是**只读**的

钩子收到的参数**不要就地改** —— 要改就**返回新对象**。

**为什么**：多个插件按固定顺序跑。如果都能就地改同一个对象，
那「谁先跑谁后跑」就会影响结果，调试时没法复现。
返回新对象的话，顺序是确定的，链式传递也很清楚。

```ts
// ✅ 对
design(design, ctx) {
  return { ...design, myField: 1 };
}

// ❌ 错 —— 就地改，同一对象会被后面的插件看到
design(design, ctx) {
  design.myField = 1;
  return design;
}
```

**返回值是 undefined / null 就表示「我不改」**，值原样传给下一个插件。

---

## 3. 完整例子

`plugins/hello.ts`：

```ts
import type { WorldPlugin, PluginContext } from "../orchestrator/src/plugins/plugin-contract.mjs";

const plugin: WorldPlugin = {
  name: "hello",

  design(design, ctx) {
    // ⚠ `ctx.logPrefix` 本身就已经是 "[Plugin]" —— 别再套一层方括号，
    // 否则日志会变成 "[[Plugin]]"。
    console.log(`${ctx.logPrefix} 我看到的世界叫 ${design.worldName}`);
    return design;          // 返回新对象；不改就 return 或者什么都不返回
  },
};

export default plugin;
```

**就这么长。** 放进 `plugins/hello.ts`，跑一次创建世界：

```bash
npm run create "一个赛博朋克的地下酒吧"
```

日志里会看到 `[Plugin] 我看到的世界叫 ...`。

> **为什么 import 路径是 `../orchestrator/src/plugins/plugin-contract.mjs`**
> —— 插件在仓库根的 `plugins/` 目录，所以是 `../`。
> 类型定义在 orchestrator 侧而不是 core，因为**加载插件必须读文件系统**，
> 而 core 定了「不碰文件系统」的边界。

---

## 4. 钩子签名

### `design(worldDesign, ctx) => worldDesign`

世界设计刚由 LLM 产出，还没生成地图。

`worldDesign` 的形状（**归一化之后**，只列常用的）：

```ts
{
  worldName: string,
  worldDescription: string,
  sceneType: string,
  timeConfig: { ... },
  multiDay: { ... },
  worldSocialContext: { ... },
  regions: Array<{ id: string; name: string; description: string }>,
  locations: Array<{ id: string; name: string; description: string }>,
  interactiveElements: Array<{ id: string; name: string }>,
  characters: Array<{ id: string; name: string; personality: string }>,
  worldActions: Array<{ id: string; name: string }>,
  mapPlan: { ... },
  economics: { items: [...] },
  relationships: { ... },
  weather: { ... },
  hearsay: { enabled: boolean },
  rules: { ... },          // 世界规则
}
```

字段的实际定义在 `orchestrator/src/world-design-utils.mjs` 的
`normalizeWorldDesign()` —— 那是唯一权威处。

**典型用途**：给世界加一个 LLM 设计阶段没覆盖的字段。

### `generate(worldDesign, ctx) => worldDesign`

素材生成阶段（地图图片、角色立绘）。

能拿到 `ctx.worldDir` —— 往那儿写文件就行。

**注意**：这个钩子收到的仍然是 `worldDesign`（不是 `ctx`）——
跟 `design` 是同一个形状。素材生成本身不产出「配置」，
这个阶段一般**不需要实现**。

### `extendWorldConfig(configs, ctx) => configs`

**最常用的钩子**。生成 `world.json` 之前，可以增补任何配置。

`configs` 的形状：

```ts
{
  worldConfig: {
    locations: Array<{
      id: string,
      name: string,
      description: string,
      adjacentLocations: string[],
      objects: Array<{ id: string; name: string; interactions: Array<...> }>,
    }>,
    mainAreaPoints: Array<{ id: string; x: number; y: number }>,
    // ...其它字段
  },
  characterConfigs: Array<{ id: string; ... }>,
  sceneConfig: { sceneType: string, ... },
}
```

**典型用途**：从已有的地点/物件推导出新配置（像 `economy` 那样生成物品库存），
或者给交互补上效果。

---

## 5. 运行时上下文 `ctx`

只读的元信息：

| 字段 | 是什么 |
|---|---|
| `ctx.worldDir` | 世界输出目录 —— 要写文件就往这儿写 |
| `ctx.userPrompt` | 用户的原始描述（那句话） |
| `ctx.worldId` | 世界 ID |
| `ctx.logPrefix` | 日志前缀 —— 打日志时带上，便于区分来源 |

---

## 6. 错误处理

**一个插件挂了不会拖垮整个世界生成** —— 除非它声明 `critical: true`。

默认行为：记录错误、**跳过这个插件**、继续跑后面的。

```ts
const plugin: WorldPlugin = {
  name: "fragile",
  critical: false,     // 默认就是 false
  design(design, ctx) {
    throw new Error("boom");   // 会被捕获，世界照常生成
  },
};
```

**校验失败是硬错误**（不静默跳过）：

- 插件不是对象 → 抛错
- 没有非空的 `name` → 抛错
- 钩子写成了字符串而不是函数 → 抛错
- 一个钩子都没实现 → 抛错

这些是**你的代码写错了**，要让你知道 —— 静默跳过会变成
「我明明写了插件为什么没生效」。

---

## 7. 顺序与开关

`config/plugins.json` 决定**顺序**和**开关**，但不决定「有没有」。

```json
{
  "plugins": [
    { "name": "economy" },
    { "name": "old-thing", "enabled": false }
  ]
}
```

- **配置文件里没提到的插件照样会跑**，只是排在后面
- 配置里 `enabled: false` 的插件被关掉
- 顺序：配置里列的按配置顺序在前，其余的按**文件名排序**在后

**为什么顺序不靠文件系统枚举**：`readdirSync` 的返回顺序**不保证**
（不同平台、不同文件系统都不一样）。靠枚举顺序的话，
「同样两个插件，换台机器跑结果就不一样」—— 这种 bug 极难查。

---

## 8. 常见任务怎么写

### 给物件的交互加一个效果

```ts
extendWorldConfig(configs, ctx) {
  const { worldConfig } = configs;
  const locations = (worldConfig as any)?.locations ?? [];

  for (const loc of locations) {
    for (const obj of loc.objects ?? []) {
      for (const inter of obj.interactions ?? []) {
        if (inter.effects?.some((e: any) => e?.type === "character_need")) continue;
        inter.effects = [...(inter.effects ?? []),
          { type: "character_need", target: "relaxation", value: 5 }];
      }
    }
  }
  return configs;
}
```

### 从世界里推导出新配置

参考 `plugins/economy.ts` —— 它从地点里的物件推出「可交易物品」，
生成 `worldConfig.economics.items`，再给交互补上 `consume_item` 效果。

**关键原则：纯逻辑，不调 LLM。**
插件阶段是在 LLM 决策**之后**跑的，插件自己再调 LLM 会让生成时间翻倍，
而且不好调试。

---

## 9. 调试

### 确认插件被加载了

日志里应该有：

```
[Plugin] 已加载 2 个插件：economy[extendWorldConfig]、hello[design]
```

没有这行 → 插件文件没被扫到，或者加载失败了（错误会打出来）。

### 加载失败常见原因

| 症状 | 原因 |
|---|---|
| `tsx 装不上` | `tsx` 必须是**运行时依赖**（在根 `package.json` 的 `dependencies` 里） |
| `Received protocol 'e:'` | 传了 Windows 绝对路径给 `import()` —— 要用 `pathToFileURL` |
| `找不到插件对象` | 要么 `export default {...}`，要么导出一个带 `name` 的具名对象 |

### 自己跑一遍钩子

不想跑完整的世界生成，可以直接调：

```js
import { loadPlugins, runHook } from "./orchestrator/src/plugins/registry.mjs";

const { plugins } = await loadPlugins();
const { value } = await runHook(plugins, "design", myDesign, ctx);
```

---

## 10. 写插件时的检查清单

- [ ] 文件在 `plugins/` 目录下（**只放一层**，子目录不会被扫到）
- [ ] 有 `name` 字段
- [ ] 至少实现一个钩子
- [ ] **不就地改参数**，要改就返回新对象
- [ ] 用 `ctx.logPrefix` 打日志
- [ ] 纯逻辑，不调 LLM
- [ ] 跑一次 `npm run create "..."`，确认日志里有你的插件名

---

## 相关文档

- [架构总览](../architecture/overview.md) —— 插件挂在哪条链上
- [配置参考](../reference/configuration.md) —— `worldConfig` 的完整字段
- `plugins/economy.ts` —— 可运行的完整例子
