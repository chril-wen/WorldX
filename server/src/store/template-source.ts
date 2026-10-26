/**
 * 提示词模板来源的 server 侧实现 —— 读仓库根的 `prompts/*.md`。
 *
 * core 只认 `PromptTemplateSource` 契约。
 * 阶段 2 之后模板统一在仓库根，路径解析在 `utils/repo-paths.ts`。
 */

import type { PromptTemplateSource } from "@own-world/core";
import { loadPromptTemplate } from "../utils/config-loader.js";

export const filesystemTemplateSource: PromptTemplateSource = {
  loadPromptTemplate,
};
