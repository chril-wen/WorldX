import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";

/**
 * 守住一个曾经让**所有 LLM 记账失效**的 bug。
 *
 * 阶段 1 搬家（774c6f1）时，`cost-tracker.ts` 里
 *   log.success ? 1 : 0
 * 被改成了
 *   log.success
 * SQLite 不接受 boolean，better-sqlite3 直接抛错。
 *
 * 而 core 那边 `logCall` 包在空的 `catch {}` 里 —— 异常被静默吞掉。
 * 结果：**每一次 LLM 调用的账单都没记进去，却没有任何报错。**
 *
 * 这条测试**直接调 server 侧真实的 `logCall`**，不复制实现 ——
 * 复制的话，改了实现测试也不会失败。
 */

let db: Database.Database;
let getDb: () => Database.Database;
let logCall: (log: any) => void;

beforeEach(async () => {
  db = new Database(":memory:");
  db.exec(`CREATE TABLE llm_call_logs (
    id TEXT PRIMARY KEY, task_type TEXT NOT NULL, character_id TEXT,
    model TEXT NOT NULL, prompt_tokens INTEGER NOT NULL,
    completion_tokens INTEGER NOT NULL, cost REAL NOT NULL,
    duration_ms INTEGER NOT NULL, success INTEGER NOT NULL,
    error TEXT, created_at TEXT DEFAULT (datetime('now'))
  );`);

  // 用 vi.mock 把 getDb 换成内存库，这样能调真实的 logCall
  vi.doMock("../store/db.js", () => ({
    getDb: () => db,
    getDbPath: () => ":memory:",
    initDatabase: () => db,
    closeDb: () => {},
  }));

  const mod = await import("./cost-tracker.js");
  getDb = (mod as any).sqliteCostTracker ? () => db : () => db;
  logCall = (mod as any).logCall;
});

afterEach(() => {
  db.close();
  vi.doUnmock("../store/db.js");
  vi.resetModules();
});

describe("cost-tracker 的 logCall", () => {
  it("success=true 能写进 SQLite（转成 1）", () => {
    logCall({
      id: "l1", taskType: "dialogue_turn", model: "m",
      promptTokens: 100, completionTokens: 50, cost: 0.1, durationMs: 20, success: true,
    });
    const row = db.prepare("SELECT * FROM llm_call_logs WHERE id=?").get("l1") as any;
    expect(row.success).toBe(1);
    expect(row.task_type).toBe("dialogue_turn");
    expect(row.cost).toBe(0.1);
  });

  it("success=false 能写进 SQLite（转成 0）", () => {
    logCall({
      id: "l2", taskType: "sandbox_chat", model: "m",
      promptTokens: 10, completionTokens: 5, cost: 0.01, durationMs: 5, success: false,
      error: "boom",
    });
    const row = db.prepare("SELECT * FROM llm_call_logs WHERE id=?").get("l2") as any;
    expect(row.success).toBe(0);
    expect(row.error).toBe("boom");
  });

  it("characterId 缺省时存 null 而不是 undefined", () => {
    logCall({
      id: "l3", taskType: "t", model: "m",
      promptTokens: 1, completionTokens: 1, cost: 0, durationMs: 1, success: true,
    });
    const row = db.prepare("SELECT character_id FROM llm_call_logs WHERE id=?").get("l3") as any;
    expect(row.character_id).toBeNull();
  });
});
