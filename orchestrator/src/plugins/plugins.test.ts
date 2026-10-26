import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validatePlugin,
  implementedHooks,
  PLUGIN_HOOKS,
} from "./plugin-contract.mjs";
import { loadPluginFile, findPluginFiles, loadPluginsFromDir } from "./loader.mjs";
import { buildPluginRegistry, runHook, loadPluginConfig } from "./registry.mjs";

/**
 * 插件机制自己的测试。
 *
 * 守的是三件事：
 * 1. **契约** —— 什么样的插件算合法
 * 2. **加载** —— `.ts` / `.mjs` 都能加载，坏的插件不拖垮别人
 * 3. **执行** —— 链式传递、错误隔离、critical 行为
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");

const tempDirs: string[] = [];

/** 仓库的 plugins/ 目录。 */
const REPO_PLUGINS_DIR = join(REPO_ROOT, "plugins");

/**
 * 临时目录建在**仓库里面**，不是系统 temp。
 *
 * 原因：vitest 的 transform 管线只覆盖项目内的文件 ——
 * 仓库外的 .ts 文件用 tsx 加载会报 "Unexpected token ':'"。
 * 这是测试环境的限制，生产环境（纯 node + tsx）没这个问题。
 */
function makeTempDir(): string {
  const base = join(REPO_ROOT, "orchestrator", "src", ".tmp-plugin-tests");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "t-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("插件契约", () => {
  it("接受一个只实现 design 的插件", () => {
    const plugin = { name: "x", design: () => ({}) };
    expect(validatePlugin(plugin)).toBe(plugin);
    expect(implementedHooks(plugin)).toEqual(["design"]);
  });

  it("拒绝没有 name 的插件", () => {
    expect(() => validatePlugin({ design: () => ({}) })).toThrow(/name/);
  });

  it("拒绝 name 是空串的插件", () => {
    expect(() => validatePlugin({ name: "  ", design: () => ({}) })).toThrow(/name/);
  });

  it("拒绝一个钩子都没实现的插件", () => {
    expect(() => validatePlugin({ name: "x" })).toThrow(/钩子/);
  });

  it("拒绝钩子不是函数的插件", () => {
    expect(() => validatePlugin({ name: "x", design: "不是函数" })).toThrow(/函数/);
  });

  it("拒绝 critical 不是布尔值的插件", () => {
    expect(() => validatePlugin({ name: "x", design: () => ({}), critical: "yes" })).toThrow(
      /布尔/,
    );
  });

  it("钩子名就是约定的三个", () => {
    expect(PLUGIN_HOOKS).toEqual(["design", "generate", "extendWorldConfig"]);
  });
});

describe("插件加载", () => {
  it("能加载 .mjs 插件（default 导出）", async () => {
    const dir = makeTempDir();
    const file = join(dir, "mjs-plugin.mjs");
    writeFileSync(
      file,
      `export default { name: "mjs-plugin", design: (d) => ({ ...d, ok: true }) };`,
    );

    const plugin = await loadPluginFile(file);
    expect(plugin.name).toBe("mjs-plugin");
  });

  it("能加载 .mjs 插件（具名导出）", async () => {
    const dir = makeTempDir();
    const file = join(dir, "named-plugin.mjs");
    writeFileSync(
      file,
      `export const plugin = { name: "named-plugin", design: (d) => d };`,
    );

    const plugin = await loadPluginFile(file);
    expect(plugin.name).toBe("named-plugin");
  }, 30_000);

  it("能加载 .ts 插件 —— 纯 node 下靠 tsx/esm/api", async () => {
    const dir = makeTempDir();
    const file = join(dir, "ts-plugin.ts");
    writeFileSync(
      file,
      `const plugin = { name: "ts-plugin", design: (d: any) => ({ ...d, ok: true }) };\n` +
        `export default plugin;\n`,
    );

    const plugin = await loadPluginFile(file);
    expect(plugin.name).toBe("ts-plugin");
  }, 30_000);

  it("加载失败时抛错，不静默返回半个插件", async () => {
    const dir = makeTempDir();
    const file = join(dir, "broken.mjs");
    writeFileSync(file, `export default { nope: true };`);

    await expect(loadPluginFile(file)).rejects.toThrow(/name/);
  });

  it("扫目录时只看一层、只认插件后缀", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "a.mjs"), "");
    writeFileSync(join(dir, "b.ts"), "");
    writeFileSync(join(dir, "notes.md"), "");
    writeFileSync(join(dir, "c.txt"), "");
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "deep.mjs"), "");

    const found = findPluginFiles(dir).map((f) => f.split(/[\\/]/).pop());
    expect(found.sort()).toEqual(["a.mjs", "b.ts"]);
  });

  it("一个坏插件不影响其它插件加载", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "good.mjs"), `export default { name: "good", design: (d) => d };`);
    writeFileSync(join(dir, "bad.mjs"), `export default { broken: true };`);

    const { plugins, errors } = await loadPluginsFromDir(dir);
    expect(plugins.map((p) => p.name)).toEqual(["good"]);
    expect(errors).toHaveLength(1);
    expect(errors[0].file).toContain("bad.mjs");
  });
});

describe("注册表", () => {
  it("配置文件不存在时返回空列表（不是错误）", () => {
    const config = loadPluginConfig(join(makeTempDir(), "nonexistent.json"));
    expect(config.plugins).toEqual([]);
  });

  it("目录里的插件文件全都算 —— 不用登记就生效", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "alpha.mjs"), `export default { name: "alpha", design: (d) => d };`);
    writeFileSync(join(dir, "beta.mjs"), `export default { name: "beta", design: (d) => d };`);

    // 配置里什么都没提
    const configPath = join(dir, "plugins.json");
    writeFileSync(configPath, JSON.stringify({ plugins: [] }));

    const { plugins, errors } = await buildPluginRegistry({
      pluginsDir: dir,
      configPath,
    });
    expect(errors).toEqual([]);
    expect(plugins.map((p) => p.name).sort()).toEqual(["alpha", "beta"]);
  });

  it("配置里的顺序在前，其余按文件名排序在后", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "zebra.mjs"), `export default { name: "zebra", design: (d) => d };`);
    writeFileSync(join(dir, "apple.mjs"), `export default { name: "apple", design: (d) => d };`);
    writeFileSync(join(dir, "mango.mjs"), `export default { name: "mango", design: (d) => d };`);

    const configPath = join(dir, "plugins.json");
    writeFileSync(configPath, JSON.stringify({ plugins: [{ name: "mango" }] }));

    const { plugins } = await buildPluginRegistry({ pluginsDir: dir, configPath });
    expect(plugins.map((p) => p.name)).toEqual(["mango", "apple", "zebra"]);
  });

  it("enabled: false 的插件被跳过", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "on.mjs"), `export default { name: "on", design: (d) => d };`);
    writeFileSync(join(dir, "off.mjs"), `export default { name: "off", design: (d) => d };`);

    const configPath = join(dir, "plugins.json");
    writeFileSync(
      configPath,
      JSON.stringify({ plugins: [{ name: "off", enabled: false }] }),
    );

    const { plugins } = await buildPluginRegistry({ pluginsDir: dir, configPath });
    expect(plugins.map((p) => p.name)).toEqual(["on"]);
  });

  it("配置里列了但目录里没有的插件 —— 记错误，不中断", async () => {
    const dir = makeTempDir();
    const configPath = join(dir, "plugins.json");
    writeFileSync(configPath, JSON.stringify({ plugins: [{ name: "ghost" }] }));

    const { plugins, errors } = await buildPluginRegistry({
      pluginsDir: dir,
      configPath,
    });
    expect(plugins).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toMatch(/ghost/);
  });

  it("插件名重复时后者被忽略", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "one.mjs"), `export default { name: "dup", design: (d) => d };`);
    writeFileSync(join(dir, "two.mjs"), `export default { name: "dup", design: (d) => d };`);

    const configPath = join(dir, "plugins.json");
    writeFileSync(configPath, JSON.stringify({ plugins: [] }));

    const { plugins, errors } = await buildPluginRegistry({
      pluginsDir: dir,
      configPath,
    });
    expect(plugins).toHaveLength(1);
    expect(errors.some((e) => e.error.includes("重复"))).toBe(true);
  });
});

describe("钩子执行", () => {
  const ctx = {
    worldDir: "/tmp/x",
    userPrompt: "test",
    worldId: "w1",
    logPrefix: "[Plugin]",
  };

  it("值按顺序链式传递", async () => {
    const a = { name: "a", design: (d: any) => ({ ...d, a: 1 }) };
    const b = { name: "b", design: (d: any) => ({ ...d, b: (d.a ?? 0) + 1 }) };

    const result = await runHook([a, b], "design", {}, ctx);
    expect(result.value).toEqual({ a: 1, b: 2 });
    expect(result.executed).toEqual(["a", "b"]);
  });

  it("返回 undefined 表示不改 —— 值原样传下去", async () => {
    const a = { name: "a", design: () => undefined };
    const original = { keep: true };

    const result = await runHook([a], "design", original, ctx);
    expect(result.value).toBe(original);
    expect(result.executed).toEqual(["a"]);
  });

  it("没实现该钩子的插件被跳过", async () => {
    const onlyGenerate = { name: "g", generate: () => {} };
    const result = await runHook([onlyGenerate], "design", { x: 1 }, ctx);
    expect(result.executed).toEqual([]);
    expect(result.value).toEqual({ x: 1 });
  });

  it("普通插件出错 —— 记错误、跳过、值不变", async () => {
    const bad = {
      name: "bad",
      design: () => {
        throw new Error("故意炸的");
      },
    };
    const original = { v: 1 };

    const result = await runHook([bad], "design", original, ctx);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/故意炸的/);
    expect(result.value).toBe(original);
  });

  it("出错的插件不挡住后面的插件", async () => {
    const bad = {
      name: "bad",
      design: () => {
        throw new Error("炸");
      },
    };
    const good = { name: "good", design: (d: any) => ({ ...d, ok: true }) };

    const result = await runHook([bad, good], "design", {}, ctx);
    expect(result.executed).toEqual(["good"]);
    expect(result.value.ok).toBe(true);
  });

  it("critical 插件出错 —— 中止整个生成", async () => {
    const crit = {
      name: "crit",
      critical: true,
      design: () => {
        throw new Error("关键插件炸了");
      },
    };

    await expect(runHook([crit], "design", {}, ctx)).rejects.toThrow(/关键插件/);
  });

  it("异步钩子会被 await", async () => {
    const slow = {
      name: "slow",
      design: async (d: any) => {
        await new Promise((r) => setTimeout(r, 10));
        return { ...d, async: true };
      },
    };

    const result = await runHook([slow], "design", {}, ctx);
    expect(result.value.async).toBe(true);
  });
});

describe("仓库里的示例插件", () => {
  it("economy 插件能加载，且实现了 extendWorldConfig", async () => {
    const { plugins, errors } = await loadPluginsFromDir(REPO_PLUGINS_DIR);
    expect(errors).toEqual([]);

    const economy = plugins.find((p) => p.name === "economy");
    expect(economy).toBeDefined();
    expect(implementedHooks(economy!)).toEqual(["extendWorldConfig"]);
  });

  it("economy 插件产出的东西符合 core 的 ItemDefinition 契约", async () => {
    const { plugins } = await loadPluginsFromDir(REPO_PLUGINS_DIR);
    const economy = plugins.find((p) => p.name === "economy")!;

    const bundle = {
      worldConfig: {
        locations: [
          {
            id: "main_area",
            name: "茶馆",
            objects: [
              {
                id: "tea_counter",
                name: "柜台",
                interactions: [{ id: "order_tea", name: "点茶", effects: [] }],
              },
            ],
          },
        ],
      },
      characterConfigs: [],
      sceneConfig: { sceneType: "open" },
    };

    const result = await runHook([economy], "extendWorldConfig", bundle, {
      worldDir: "/tmp/x",
      userPrompt: "t",
      worldId: "w",
      logPrefix: "[Plugin]",
    });

    const items = (result.value as any).worldConfig.economics.items;
    expect(items).toHaveLength(1);

    const item = items[0];
    // core 的 ItemDefinition 契约
    expect(typeof item.id).toBe("string");
    expect(typeof item.name).toBe("string");
    expect(typeof item.initialStock).toBe("number");
    // displayStates 是 {状态文案: 阈值} —— 键是文案，值是数字
    for (const [state, threshold] of Object.entries(item.displayStates)) {
      expect(typeof state).toBe("string");
      expect(typeof threshold).toBe("number");
    }
  });

  it("economy 给交互补上了 consume_item 效果", async () => {
    const { plugins } = await loadPluginsFromDir(REPO_PLUGINS_DIR);
    const economy = plugins.find((p) => p.name === "economy")!;

    const bundle = {
      worldConfig: {
        locations: [
          {
            id: "main_area",
            name: "茶馆",
            objects: [
              {
                id: "tea_counter",
                name: "柜台",
                interactions: [{ id: "order_tea", name: "点茶", effects: [] }],
              },
            ],
          },
        ],
      },
      characterConfigs: [],
      sceneConfig: {},
    };

    const result = await runHook([economy], "extendWorldConfig", bundle, {
      worldDir: "/tmp/x",
      userPrompt: "t",
      worldId: "w",
      logPrefix: "[Plugin]",
    });

    const effects = (result.value as any).worldConfig.locations[0].objects[0]
      .interactions[0].effects;
    expect(effects.some((e: any) => e.type === "consume_item")).toBe(true);
  });
});
