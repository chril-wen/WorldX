/**
 * 提示词模板来源的 server 侧实现 —— 读 `configs/prompts/*.md`。
 *
 * core 只认 `PromptTemplateSource` 契约。
 * 阶段 2 会把这批模板统一到仓库根的 `prompts/` 目录，届时只改这一处。
 */

import type { PromptTemplateSource } from "@worldx/core";
import { loadPromptTemplate } from "../utils/config-loader.js";

export const filesystemTemplateSource: PromptTemplateSource = {
  loadPromptTemplate,
};
