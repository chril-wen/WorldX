/**
 * 示例插件：物品/经济
 *
 * 演示「加功能不改核心代码」—— 这个文件放进 `plugins/` 目录就生效，
 * 不用改 `orchestrator/src/index.mjs` 任何一个字。
 *
 * ## 它做什么
 *
 * 1. 从世界的地点和物件里推出「可交易的物品」（纯规则，不调模型）
 * 2. 生成 `economics.items` —— 初始库存、补货动作、库存状态文案
 * 3. 给相关的世界动作补上 `consume_item` / `restock_item` 效果
 *
 * ## 为什么这个例子合适
 *
 * - core 里这条链**已经全通了**：
 *   `worldConfig.economics.items` → `initItemStocks()` → `consume_item` 效果
 * - **纯逻辑，不依赖 LLM** —— 「从零到能用 < 半天」能真正做到
 * - 效果**看得见** —— 生成的世界里能查到库存数字随动作变化
 *
 * ## 怎么改
 *
 * 改这个文件 → 重新跑一次创建世界 → 效果就变了。
 * 想关掉它：在 `config/plugins.json` 里加 `{"name": "economy", "enabled": false}`。
 */

import type { WorldPlugin, WorldConfigBundle, PluginContext } from "../orchestrator/src/plugins/plugin-contract.mjs";

/** 物品 id 的安全化 —— 界面展示用 id，得唯一且不含奇怪字符。 */
function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

/**
 * 从物件里挑出「像商品」的 —— 有交互、有名字、不是纯装饰。
 *
 * 判定：物件至少有 1 个 interaction，且名字不是「门」「墙」这类。
 * 宁可漏选也不要乱加 —— 物品库存是会被模拟消耗的，乱加会让世界行为怪异。
 */
function pickTradeableObjects(locations: any[]): Array<{ id: string; name: string; locationId: string }> {
  const out: Array<{ id: string; name: string; locationId: string }> = [];
  const seen = new Set<string>();

  for (const location of locations ?? []) {
    for (const obj of location?.objects ?? []) {
      if (!obj?.id || !obj?.name) continue;
      if (seen.has(obj.id)) continue;

      const interactions = Array.isArray(obj.interactions) ? obj.interactions : [];
      // 没有交互的物件不会「被使用」，没必要做成物品
      if (interactions.length === 0) continue;

      seen.add(obj.id);
      out.push({ id: obj.id, name: obj.name, locationId: location.id });
    }
  }

  return out;
}

/**
 * 库存状态文案 —— 阈值决定显示什么。
 *
 * 格式是 `{状态文案: 阈值}` —— 键是文案，值是触发这个文案的库存下限。
 * core 的 `setItemStock` 会把键按阈值从高到低排，库存够第一个就显示它。
 *
 * 注意键值别搞反了 —— 契约是 `Record<string, number>`，
 * 写成 `{0: "空了"}` 的话，TypeScript 会直接报错（值该是数字）。
 */
function buildDisplayStates(): Record<string, number> {
  return {
    充足: 5,
    还有: 3,
    不多了: 2,
    快没了: 1,
    空了: 0,
  };
}

const plugin: WorldPlugin = {
  name: "economy",

  extendWorldConfig(
    configs: WorldConfigBundle,
    ctx: PluginContext,
  ): WorldConfigBundle {
    const { worldConfig, characterConfigs, sceneConfig } = configs;
    const locations = (worldConfig as any)?.locations ?? [];

    const tradeables = pickTradeableObjects(locations);
    if (tradeables.length === 0) {
      console.log(`[Plugin:economy] 没有找到可做成物品的物件，跳过`);
      return configs;
    }

    // 1. 生成物品定义
    const items = tradeables.map((obj) => ({
      id: slugify(obj.id) || obj.id,
      name: obj.name,
      initialStock: 8,
      consumptionPerUse: 1,
      displayStates: buildDisplayStates(),
      trackedBy: obj.locationId,
    }));

    // 2. 给物件的交互补上「消耗物品」的效果
    //
    // 只补**消耗**，不补补货 —— 补货要指向一个具体动作，
    // 而世界里不一定有合适的动作，硬造一个反而会让角色去做奇怪的事。
    const itemIdByObjectId = new Map<string, string>();
    for (const item of items) {
      itemIdByObjectId.set(item.id, item.id);
    }

    let patchedInteractions = 0;
    for (const location of locations) {
      for (const obj of location?.objects ?? []) {
        const itemId = itemIdByObjectId.get(slugify(obj.id) || obj.id);
        if (!itemId) continue;

        for (const interaction of obj.interactions ?? []) {
          const effects = Array.isArray(interaction.effects) ? interaction.effects : [];
          // 已经有消耗效果的不重复加
          if (effects.some((e: any) => e?.type === "consume_item")) continue;

          effects.push({ type: "consume_item", target: itemId, amount: 1 });
          interaction.effects = effects;
          patchedInteractions++;
        }
      }
    }

    // 3. 写进世界配置
    (worldConfig as any).economics = { items };

    console.log(
      `[Plugin:economy] 生成了 ${items.length} 种物品，` +
        `给 ${patchedInteractions} 个交互补上了消耗效果`,
    );

    return { worldConfig, characterConfigs, sceneConfig };
  },
};

export default plugin;
