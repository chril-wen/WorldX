/**
 * `own-world plugins` —— 列出已加载的插件。
 *
 * ## 为什么要有这个命令
 *
 * 插件挂在**世界生成流程**上（`design` / `generate` / `extendWorldConfig`）。
 * 想验证插件能不能加载，本来只能跑 `npm run create` ——
 * 那要几分钟，还要 LLM，而且会真的生成一个世界。
 *
 * 「加个插件文件，不跑生成，怎么知道它被认出来了？」
 * ——这个问题必须有便宜的答案。
 *
 * 插件加载器（`orchestrator/src/plugins/loader.mjs`）只读文件系统，
 * 不碰 LLM、不碰 server —— 所以这个命令**秒回**。
 *
 * ## 它不做什么
 *
 * 不跑钩子。只**加载并列出** ——
 * 钩子要到生成流程里才有意义。
 */

import { emit, section } from "../lib/format.mjs";

/**
 * 列出插件。
 *
 * @param {object} ctx
 */
export async function cmdPlugins({ flags }) {
  const asJson = flags.has("json");

  // 直接用 orchestrator 的 registry —— 那是**唯一**的实现。
  // 自己再扫一遍 `plugins/` 目录会跟它分叉（比如配置里的
  // `enabled: false` 开关、重复名检查）。
  //
  // 路径：从 `apps/cli/src/commands/` 上溯四级到仓库根。
  const { loadPlugins, implementedHooks } = await import(
    "../../../../orchestrator/src/plugins/registry.mjs"
  );

  // registry 会自己打 `[Plugin] 已加载 N 个插件：...` ——
  // 那是它该有的输出，这里不重复打。
  const { plugins, errors } = await loadPlugins({});

  const data = {
    plugins: plugins.map((p) => ({
      name: p.name,
      hooks: implementedHooks(p),
    })),
    errors: errors.map((e) => ({ source: e.source, error: e.error })),
  };

  emit({
    data,
    json: JSON.stringify(data, null, 2),
    asJson,
    human: () => {
      if (plugins.length === 0) {
        console.log("没有加载任何插件。");
        return;
      }

      section(`插件（${plugins.length}）`, () => {
        for (const p of data.plugins) {
          const hooks = p.hooks.length > 0 ? p.hooks.join(" / ") : "（没有钩子）";
          console.log(`  ${p.name}  →  ${hooks}`);
        }
      });

      if (errors.length > 0) {
        section(`加载失败（${errors.length}）`, () => {
          for (const e of errors) {
            console.log(`  ${e.source}：${e.error}`);
          }
        });
      }
    },
  });
}
