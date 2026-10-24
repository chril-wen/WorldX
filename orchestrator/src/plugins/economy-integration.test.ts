import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPluginsFromDir } from "./loader.mjs";
import { runHook } from "./registry.mjs";
import { InMemoryWorldStateStorage } from "../../../packages/core/src/testing/in-memory-world-state.js";

/**
 * 端到端：插件写出的东西，core 真的认。
 *
 * 这是阶段 3 最重要的一条测试 —— 前面那些只证明「插件跑了」，
 * 这条证明「插件跑出来的**结果**是对的」。
 *
 * 链条：
 *   插件产出 economics.items
 *     → core 的 initItemStocks() 初始化库存
 *     → consume_item 效果消耗库存
 *     → 库存状态文案正确
 *
 * 之前阶段 2 出的那个 bug（LLM 记账全失效）就是这种类型 ——
 * 链路每一段都「存在」，但没人验证过接起来对不对。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const REPO_PLUGINS_DIR = join(REPO_ROOT, "plugins");

const CTX = {
  worldDir: join(REPO_ROOT, "output", "tmp"),
  userPrompt: "test",
  worldId: "test",
  logPrefix: "[Plugin]",
};

/** 跑 economy 插件，返回增补后的配置。 */
async function runEconomyPlugin(worldConfig: any) {
  const { plugins } = await loadPluginsFromDir(REPO_PLUGINS_DIR);
  const economy = plugins.find((p) => p.name === "economy");
  expect(economy).toBeDefined();

  const result = await runHook(
    [economy],
    "extendWorldConfig",
    { worldConfig, characterConfigs: [], sceneConfig: {} },
    CTX,
  );
  return result.value as any;
}

const SAMPLE_WORLD = {
  locations: [
    {
      id: "main_area",
      name: "夜市",
      objects: [
        {
          id: "cake_stall",
          name: "炊饼摊",
          interactions: [
            { id: "buy_cake", name: "买炊饼", effects: [] },
            { id: "smell_cake", name: "闻饼香", effects: [] },
          ],
        },
        {
          id: "fortune_booth",
          name: "卦摊",
          interactions: [{ id: "ask_fortune", name: "问一卦", effects: [] }],
        },
        {
          id: "wall",
          name: "土墙",
          interactions: [],
        },
      ],
    },
  ],
};

describe("插件产出 → core 真的认", () => {
  it("core 的 initItemStocks 能把插件的物品变成库存", async () => {
    const out = await runEconomyPlugin(structuredClone(SAMPLE_WORLD));
    const items = out.worldConfig.economics.items;

    const worldState = new InMemoryWorldStateStorage();
    worldState.initItemStocks(items);

    const stock = worldState.getItemStock("cake_stall");
    expect(stock).not.toBeNull();
    expect(stock!.stock).toBe(8);
  });

  it("初始库存的文案按插件的 displayStates 翻译正确", async () => {
    const out = await runEconomyPlugin(structuredClone(SAMPLE_WORLD));
    const items = out.worldConfig.economics.items;

    const worldState = new InMemoryWorldStateStorage();
    worldState.initItemStocks(items);

    // 初始库存 8 → 阈值里最高的是 5（充足），8 >= 5
    expect(worldState.getItemStock("cake_stall")!.state).toBe("充足");
  });

  it("消耗之后库存减少，文案跟着变", async () => {
    const out = await runEconomyPlugin(structuredClone(SAMPLE_WORLD));
    const items = out.worldConfig.economics.items;

    const worldState = new InMemoryWorldStateStorage();
    worldState.initItemStocks(items);

    const item = items.find((i: any) => i.id === "cake_stall");

    // 模拟 core 的 consumeItem：扣 1，然后按 displayStates 重新算文案
    let stock = worldState.getItemStock("cake_stall")!.stock;
    for (let i = 0; i < 3; i++) {
      stock = Math.max(0, stock - 1);
      worldState.setItemStock("cake_stall", stock, item.displayStates);
    }

    expect(worldState.getItemStock("cake_stall")!.stock).toBe(5);
    expect(worldState.getItemStock("cake_stall")!.state).toBe("充足");

    // 再扣到 3 → 阈值 3（还有）
    stock = 3;
    worldState.setItemStock("cake_stall", stock, item.displayStates);
    expect(worldState.getItemStock("cake_stall")!.state).toBe("还有");

    // 扣到 0 → 「空了」
    stock = 0;
    worldState.setItemStock("cake_stall", stock, item.displayStates);
    expect(worldState.getItemStock("cake_stall")!.state).toBe("空了");
  });

  it("插件的 consume_item 效果指向的物品都存在（没有悬空 target）", async () => {
    const out = await runEconomyPlugin(structuredClone(SAMPLE_WORLD));
    const itemIds = new Set<string>(
      out.worldConfig.economics.items.map((i: any) => i.id),
    );

    const targets: string[] = [];
    for (const loc of out.worldConfig.locations) {
      for (const obj of loc.objects ?? []) {
        for (const it of obj.interactions ?? []) {
          for (const e of it.effects ?? []) {
            if (e.type === "consume_item") targets.push(e.target);
          }
        }
      }
    }

    expect(targets.length).toBeGreaterThan(0);
    for (const t of targets) {
      expect(itemIds.has(t), `consume_item 指向了不存在的物品 "${t}"`).toBe(true);
    }
  });

  it("没有交互的物件不会被做成物品", async () => {
    const out = await runEconomyPlugin(structuredClone(SAMPLE_WORLD));
    const itemIds = out.worldConfig.economics.items.map((i: any) => i.id);

    // 「土墙」没有 interaction —— 做成物品的话库存永远不变，没意义
    expect(itemIds).not.toContain("wall");
  });
});
