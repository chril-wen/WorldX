/**
 * LLM 端口契约 —— core 只描述「需要模型做什么」，不关心谁来实现。
 *
 * server 的 `LLMClient` 实现这个接口；core 里凡是调模型的代码都只认这个接口。
 * 这样换 provider（阶段 2）时 core 不用动，也能在测试里塞假模型。
 */

import type { ZodSchema } from "zod";
import type { LLMCallOptions, LLMCallResult, Message } from "./index.js";

export interface LLMClient {
  call<T>(params: {
    messages: Message[];
    schema: ZodSchema<T>;
    options: LLMCallOptions;
  }): Promise<LLMCallResult<T>>;
}
