# 阶段 6 · 逐点体验清单

> 打印出来照着走。每一条后面有「**看点**」——那是要判断的东西，不是操作步骤。
>
> 环境：server 已在跑（3100），client 已在跑（3200）。
> 所有 CLI 命令在 `E:\WordX\OWN-World` 下用 `npm run cli --` 前缀。

---

## A · CLI（10 分钟）

### A1 · 命令面完整吗

```bash
npm run cli -- help
```

**看点**：11 个命令在不在（create / worlds / world / locations / status / tick /
characters / events / rules / timeline / help）。`[要 server]` 标记清楚吗。
有没有你以为该有但没有的命令。

### A2 · 事件终于能读了

```bash
npm run cli -- tick
```

**看点**（这是阶段 6 改得最多的地方）：

```
事件
────
  赵龙 → 林哲：「做买卖？卖什么，落脚在哪儿？」
```

- 是不是人话，而不是 `{"id":"y5GvZz...","gameDay":1,...}` 这种原始 JSON
- 角色名显示的是「赵龙」还是 `char_1792860312745`
- 缺信息时读得懂吗（比如「某人在主区域 闲逛观察」——地点对不对）

### A3 · 事件流能筛

```bash
npm run cli -- events --limit 10
npm run cli -- events --type dialogue
```

**看点**：筛出来的对不对。时间标注（第1天）够不够。

### A4 · 地点一致性检查

```bash
npm run cli -- locations --world world_2026-10-20T11-06-51
```

**看点**：末尾那行

```
  ✓ TMJ（10）与 world.json（11）一致（中心区域例外）
```

「中心区域例外」这个说法清楚吗？你能不能立刻知道**为什么**会有这个例外
（提示：看 `docs/reference/configuration.md` §6）。

### A5 · 不需要 server 的命令，离线能用

这是 CLI 最主要的设计决定。**验证它**：

```bash
npm run cli -- worlds
npm run cli -- locations
npm run cli -- rules list
```

**看点**：这三个是不是在 server 停掉时照样能用（预期：能）。
反过来，`status` / `tick` / `characters` / `events` 停掉 server 时
是不是给一句「先启动：npm run dev:server」，而不是甩一个 ECONNREFUSED。

### A6 · L3 链路：快照 → 分叉 → 对比

```bash
npm run cli -- timeline list
npm run cli -- timeline snapshot tl-20261026-081913 --desc "体验分岔点"
npm run cli -- timeline snapshots tl-20261026-081913
npm run cli -- timeline fork tl-20261026-081913 <刚拿到的snapshotId> --label "另一种可能"
npm run cli -- timeline diff tl-20261026-081913 tl-fork-xxx
```

**看点**：`diff` 的输出你看得懂吗？「共有 3，只 A 有 0，只 B 有 0」这种
数字对比，是不是比一堆原始数据有用。**这是 L3 的门面**。

### A7 · 给脚本用

```bash
npm run cli -- worlds --json
npm run cli -- tick --json
```

**看点**：`--json` 里的字段跟表格里显示的是不是同一套（不该有「表格里有、
JSON 里没有」的字段）。

---

## B · 文档（30 分钟）

### B1 · 入口能找到路吗

打开 [docs/README.md](docs/README.md)。

**看点**：拿一张「我要改 X」的表。**你会先看哪一行**？够不够用？

### B2 · 架构文档能定位模块吗

打开 [docs/architecture/overview.md](docs/architecture/overview.md) §3 模块地图。

**看点**（这题是阶段 6 的成功标尺）：
「我要改角色决策的算法」→ 你能只靠这份文档定位到文件吗？
「我要加一个世界动作」→ 呢？

### B3 · 反直觉的地方，说清了吗

[docs/architecture/overview.md](docs/architecture/overview.md) §7 几个反直觉的地方。

**看点**：读完你知道「改 `TILE_SIZE = 32` 不会有任何可见变化」吗？
知道 `main_area` 为什么没有矩形吗？知道插件钩子为什么没有 `simulate` 吗？

### B4 · 配置参考的「不生效」警告

[docs/reference/configuration.md](docs/reference/configuration.md) §5.2。

**看点**：那个 `character_need` 的警告块——

- 结论明确吗（「16 条里只有 8 条生效」）
- 给了**怎么加一个新维度**的指引吗
- 你能据此判断「我写的这个 target 到底生不生效」吗

### B5 · 规则改了怎么验证

[docs/guides/world-rules.md](docs/guides/world-rules.md) §6。

**看点**：这节是整份文档里最实用的。你能照着走一遍「改规则 → 确认生效」
吗？中间有没有需要猜的地方？

### B6 · 插件指南（半天标尺）

**别看代码**，照 [docs/guides/plugins.md](docs/guides/plugins.md) §3 字面写：

```bash
cat > plugins/hello.ts <<'EOF'
import type { WorldPlugin } from "../orchestrator/src/plugins/plugin-contract.mjs";

const plugin: WorldPlugin = {
  name: "hello",
  design(design, ctx) {
    console.log(`${ctx.logPrefix} 我看到的世界叫 ${design.worldName}`);
    return design;
  },
};

export default plugin;
EOF
```

然后跑任何带 `plugins/` 的命令（`timeline list` 就够），
应该看到 `[Plugin] 已加载 2 个插件：economy[extendWorldConfig], hello[design]`。

**看点**：从打开文档到插件被加载，你花了多久？
有没有哪一步需要翻代码才知道怎么办？**那就是文档没写清楚的地方。**

---

## C · 浏览器（5 分钟）

打开 **http://localhost:3200**

**看点**：
- 世界列表、角色列表、事件日志、上帝视角、架空对话，能用吗
- 游戏画面（Phaser 那块）显示得出来吗
- 有没有哪个地方让你觉得「这信息为什么在这儿」

---

## D · 归属（1 分钟）

打开 [docs/ATTRIBUTION.md](docs/ATTRIBUTION.md) 和仓库根的 `LICENSE`。

**看点**：许可证对吗？原作者记清楚了吗？

---

## 做完之后

三件事，随你挑：

1. **记下所有让你卡住的地方** —— 不用客气，「这句看不懂」也是有效反馈
2. 或者直接说「A3 的输出看不懂」，我们改
3. 或者你验收完了，去 [REPORTS/phase-06.md](file:///E:/WordX/OWN-World-design/product/REPORTS/phase-06.md) §四 回答那三个待拍板的问题
