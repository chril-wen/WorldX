# 规则外置指南

> **讲什么**：怎么改世界的规则、怎么**验证改了真的生效**。
>
> **一句话**：WorldX 的规则是**数据**（在 `world.json` 的 `rules` 段），
> 不是代码里的常数。改一个衰减率不用改代码、不用重建世界。

---

## 1. 规则在哪

**在 `world.json` 里**，不在代码里，也不在单独的配置文件里。

```jsonc
{
  "rules": {
    "emotion": { /* 14 个参数 */ },
    "needs":   { /* 3 个参数 */ },
    "memory":  { /* 6 个参数 */ }
  }
}
```

**为什么放在 world.json 里而不是单独一个文件**：
因为**规则是这个世界的一部分**。跟世界一起存、一起复制、一起版本管理，
比放在某个全局配置文件里更不容易走散 —— 换世界时规则跟着换。

---

## 2. 列出所有规则

```bash
npm run rules -- list
```

会打印每个参数的**当前值**、默认值和取值范围。**先看这个再改**，
别猜参数名（`emotion.decay` 和 `emotion.decayRate` 是两个东西，
只有后者存在）。

---

## 3. 改规则

```bash
npm run rules -- set <path> <value> [--world <worldId>]
```

例如：

```bash
npm run rules -- set emotion.decayRate 0.9
npm run rules -- set memory.recencyDecayRate 0.1
```

**路径写法**：`emotion.decayRate`、`memory.recencyDecayRate`。
（`rules.mjs` 有个别名机制，文档里的老写法也能用，但落盘时
一律存**规范名**。）

### 角色级 override

同一个角色的规则可以单独改，前面接角色 id：

```bash
npm run rules -- set <characterId> <path> <value>
npm run rules -- set char_1792494562655 emotion.decayRate 0.8
```

角色级只写**要改的项**，其余继承世界级。

看某个角色**当前生效**的规则（世界级 + 角色级合并后）：

```bash
npm run rules -- show <characterId>
```

### 重置

```bash
npm run rules -- reset <path>        # 重置世界规则的一项
npm run rules -- reset                # 重置世界全部规则
npm run rules -- reset <characterId>  # 重置某角色的全部 override
```

### 不传 `--world` 时用哪个世界

**最近改动的那个生成世界**（`output/worlds/` 下 mtime 最新的）。
想指定就加 `--world <worldId>`。

---

## 4. 越界的值会被钳制，不是报错

规则值有**三个**入口：world.json、角色配置、**LLM 直出**。

越界的值**不会报错**，只会被**钳制**到合法范围 —— 之前这里是坏的，
`decayRate=1.8` 会让 6 个 tick 之后效价从 3 涨到 46875。

现在的防线有三层：

1. **`RULE_RANGES` 范围表** —— 37 个参数全覆盖，
   定义在 `packages/core/src/engine/rules.ts`
2. **`mergeRules` 钳制** —— 合并时就把越界值拉回范围
3. **`validateRules`** —— 外部入口显式校验

所以**改规则时不用担心填错值**，但也**不会告诉你填错了** ——
填 `1.8` 会被拉回上限，不报错。想确认自己填的值生效了，
用 `npm run rules -- show` 看实际存的是什么。

---

## 5. 改完怎么让它生效

**规则是启动时读进内存的。** 改完 world.json 后：

```bash
curl -X POST http://localhost:3100/api/world/reload
```

或者重启 server。

> CLI 会提示「记得 reload」，但**不主动去碰 server** ——
> CLI 不该对运行中的进程有副作用。

---

## 6. 怎么验证「真的生效了」

这是最重要的一节。**别假设它生效了** —— 改完不验证，
你不知道自己改的是对的还是没接线。

### 6.1 先看值有没有写对

```bash
npm run rules -- show
```

看到你改的值，就说明**写进去了**。但这只证明落盘成功，
不证明运行时读了。

### 6.2 冒烟：走真实链路

```bash
node scripts/rules-smoke.mjs
```

这个脚本走**真实链路**：server 的 config-loader 读真 world.json →
WorldManager → CharacterManager → `tickPassiveUpdate`。

**不是**拿 core 的假 config source 糊弄 —— 那样只能证明 core 内部自洽，
证明不了「world.json 改了真的会生效」。

它验两件事：
1. 改 world.json 之后行为真的变了（规则接上了运行时）
2. 默认规则下行为跟改造前完全一致（抽取没漂移）

### 6.3 对拍：端到端差异

```bash
node scripts/rules-ab.mjs
```

跑两遍模拟（规则不同），对比角色的记忆、对话、反思。

**难点是 LLM 不确定** —— 真实模型的输出有随机性，
「跑两遍对比结果」没法直接做，两次的差异可能全来自模型。

**解法**：注入**确定性的假 LLM**。core 的 `LLMClient` 是个干净的端口，
测试能塞假的：同样的输入永远给同样的输出。于是两次运行**唯一的变量就是规则**，
任何差异都必然来自规则。

> 补充一个真 LLM 的对比脚本 `scripts/rules-real-compare.mjs`，
> 验的是另一半问题：「LLM 拿到新规则后，对话和记忆内容真的变了吗」。

---

## 7. 改了没生效？排查顺序

| 现象 | 检查 |
|---|---|
| `show` 里值没变 | 写错了 worldId？或者路径名拼错（`decay` vs `decayRate`） |
| `show` 里值变了，但行为没变 | **没 reload** —— 最常见 |
| reload 了还是没变 | 看 world.json 的 `rules` 段是否真的被 server 读到了 |
| 行为变了但不是你想要的 | 值被钳制了 —— 看 `show` 里的实际值 |
| 某个角色不变 | 角色级 override 覆盖了世界级 —— `show <characterId>` 看合并后的值 |

---

## 8. 完整流程示例

```bash
# 1. 看有哪些规则
npm run rules -- list

# 2. 改一条
npm run rules -- set emotion.decayRate 0.9

# 3. 确认写进去了
npm run rules -- show

# 4. 冒烟：走真实链路验
node scripts/rules-smoke.mjs

# 5. reload 让 server 用上
curl -X POST http://localhost:3100/api/world/reload

# 6. 想看端到端差异，再跑对拍
node scripts/rules-ab.mjs
```

---

## 相关文档

- [配置参考](../reference/configuration.md) —— world.json 全部字段
- [架构总览](../architecture/overview.md) —— 规则在运行时的位置
- `packages/core/src/engine/rules.ts` —— `RULE_RANGES` 的权威定义
