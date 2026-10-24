# 插件

放到这个目录里的插件文件**全都算** —— 加个文件就生效，
不用改 `orchestrator/src/index.mjs` 任何一个字，也不用改 `config/plugins.json`。

```
plugins/
  README.md      ← 这个文件
  economy.ts     ← 示例插件（物品/经济）
  你的插件.ts     ← 放这儿就生效
```

---

## 从零到能用

### 1. 建一个文件

`plugins/hello.ts`：

```ts
import type { WorldPlugin } from "../orchestrator/src/plugins/plugin-contract.mjs";

const plugin: WorldPlugin = {
  name: "hello",

  design(design, ctx) {
    console.log(`[${ctx.logPrefix}] 我看到的世界叫 ${design.worldName}`);
    return design;          // 返回新对象；不改就 return / 什么都不返回
  },
};

export default plugin;
```

### 2. 跑一次创建世界

```bash
npm run create "一个赛博朋克的地下酒吧"
```

日志里会出现：

```
[Plugin] 已加载 2 个插件：economy[extendWorldConfig], hello[design]
[Plugin] design 阶段跑了：hello
```

**不用改任何核心代码。**

### 3. 收工

就这样。插件文件删掉，世界生成照旧。

---

## 钩子

三个钩子，实现哪个就参与哪个阶段 —— 没实现的直接跳过。

| 钩子 | 什么时候跑 | 拿到什么 | 能改什么 |
|---|---|---|---|
| `design` | 世界设计完成后 | 世界设计 | 返回新的设计对象 |
| `generate` | 地图和角色都生成完之后 | 世界设计 + `ctx.worldDir` | 往 `worldDir` 里写文件 |
| `extendWorldConfig` | 配置生成时（**写盘之前**） | `{worldConfig, characterConfigs, sceneConfig}` | 返回增补后的配置 |

### 参数是只读的

钩子收到的参数**不要就地改** —— 要改就返回新对象。

原因：多个插件按固定顺序跑，如果都能就地改同一个对象，
那「谁先跑谁后跑」就会影响结果，调试时没法复现。

```ts
// ✅ 对
design(design) {
  return { ...design, myField: 1 };
}

// ❌ 错 —— 后面的插件会看到你改过的东西，顺序就不可复现了
design(design) {
  design.myField = 1;
}
```

### 上下文

```ts
{
  worldDir:    string,   // 世界输出目录 —— generate 钩子往这儿写
  userPrompt: string,   // 用户的原始描述
  worldId:     string,   // 世界 ID
  logPrefix:   string,   // "[Plugin]"
}
```

---

## 出错了怎么办

**普通插件出错 → 记录警告，跳过，继续跑后面的。**

主流程不会因为第三方代码出错就整个失败。日志里会有：

```
[Plugin] "my-plugin" 在 design 阶段失败，已跳过：<错误信息>
```

**关键插件出错 → 中止整个世界生成。**

声明 `critical: true`：

```ts
const plugin: WorldPlugin = {
  name: "must-succeed",
  critical: true,        // 失败就中止
  design(design) { ... },
};
```

---

## 顺序和开关

`config/plugins.json` 只用来**调顺序**和**关掉某个插件**：

```json
{
  "plugins": [
    { "name": "economy" },
    { "name": "old-thing", "enabled": false }
  ]
}
```

- **顺序**：配置里列的按配置顺序在前，其余的按**文件名排序**在后。
  不用文件系统的枚举顺序 —— 那个不保证，换台机器结果就不一样。
- **关掉**：`"enabled": false`。

配置文件不存在也没关系 —— 那就是「不调顺序、不关任何插件」。

---

## 写 `.ts` 还是 `.mjs`

两种都行：

- **`.ts`** —— 推荐。有类型提示，插件作者能少踩很多坑。
  加载靠 `tsx/esm/api`（`tsx` 是**运行时依赖**，不是 devDependency）。
- **`.mjs`** —— 纯 JavaScript。不用装 tsx 也能跑。

导出方式两种都认：

```ts
export default { name: "x", ... }        // 默认导出
export const plugin = { name: "x", ... }   // 具名导出
```

---

## 写插件之前先看一眼 core 契约

插件能改的东西是有限的 —— 改到 core 不认识的地方，core 会忽略。

能改的字段看 `packages/core/src/contracts/world.ts`：

- `WorldConfig` —— 世界配置（`locations`、`worldActions`、`economics`、`weather`、`hearsay`…）
- `ItemDefinition` —— 物品定义（`economy.items` 的元素）
- `Effect` —— 交互效果

**两个已知的类型缺口**（写 TS 插件时会撞到）：

1. `Effect` 的类型联合里**没有** `consume_item` / `restock_item`，
   但 runtime 是支持的（`action-executor.ts:453`）。示例插件就是用这个 ——
   写 TS 时可能要 `as any`，或者给 `Effect` 补上这两个类型
   （那属于改 core，得单独讨论）。

2. `ItemDefinition.displayStates` 的类型是 `Record<string, number>`，
   也就是 **`{状态文案: 阈值}`** —— 键是文案，值是库存下限。
   写成 `{0: "空了"}` 会被 TypeScript 拦下来（值该是数字）。
   runtime 按阈值从高到低匹配，库存够第一个就显示它。

**插件目录有类型检查** —— `npm run typecheck:plugins` 会跑
`tsc --noEmit -p tsconfig.plugins.json`。上面的第 2 点就是这么发现的。

---

## 看看示例插件

`plugins/economy.ts` —— 从世界的物件推出可交易的物品，
生成 `economics.items`，给交互补上 `consume_item` 效果。

纯逻辑，不调模型 —— 这是「从零到能用 < 半天」能真正做到的原因。
