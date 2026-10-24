/**
 * 提示词模板来源 —— core 读模板，不关心模板从哪来。
 *
 * server 的实现读仓库根的 `prompts/*.md`（阶段 2 之后统一在那里）。
 * core 不碰文件系统，所以这里只声明「能按名字读到一个模板」这件事。
 */

export interface PromptTemplateSource {
  /** 读一个模板的原始文本（不含 {{var}} 替换）。 */
  loadPromptTemplate(name: string): string;
}
