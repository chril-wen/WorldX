/**
 * 提示词模板来源 —— core 读模板，不关心模板从哪来。
 *
 * server 的实现读 `configs/prompts/*.md`；阶段 2 会把这批模板统一到仓库根的
 * `prompts/` 目录，那时只改 server 侧的实现，core 不动。
 */

export interface PromptTemplateSource {
  /** 读一个模板的原始文本（不含 {{var}} 替换）。 */
  loadPromptTemplate(name: string): string;
}
