import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDatabase, closeDb } from "../store/db.js";
import { updateMemory } from "../store/memory-store.js";
import { MemoryManager } from "./memory-manager.js";
import type { MemoryType } from "../types/index.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "worldx-mem-test-"));

// 每个用例一个全新的库文件 —— initDatabase 不会清空已有文件，
// 复用同一个文件会让数据在用例之间残留。
let dbSeq = 0;
beforeEach(() => {
  closeDb();
  dbSeq += 1;
  initDatabase(path.join(tmpDir, `test-${dbSeq}.db`));
});

afterAll(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let seq = 0;
function add(mgr: MemoryManager, overrides: Partial<{
  characterId: string;
  type: MemoryType;
  content: string;
  day: number;
  tick: number;
  importance: number;
  emotionalValence: number;
  emotionalIntensity: number;
  relatedCharacters: string[];
  relatedLocation: string;
  tags: string[];
}> = {}) {
  seq += 1;
  return mgr.addMemory({
    characterId: overrides.characterId ?? "char_1",
    type: overrides.type ?? "observation",
    content: overrides.content ?? `记忆 ${seq}`,
    gameTime: { day: overrides.day ?? 1, tick: overrides.tick ?? 0 },
    importance: overrides.importance ?? 5,
    emotionalValence: overrides.emotionalValence ?? 0,
    emotionalIntensity: overrides.emotionalIntensity ?? 5,
    relatedCharacters: overrides.relatedCharacters,
    relatedLocation: overrides.relatedLocation,
    tags: overrides.tags,
  });
}

describe("MemoryManager", () => {
  describe("addMemory", () => {
    it("返回的条目字段完整", () => {
      const mgr = new MemoryManager();
      const m = add(mgr, { content: "在茶馆遇到故人" });
      expect(m.id).toBeTruthy();
      expect(m.characterId).toBe("char_1");
      expect(m.content).toBe("在茶馆遇到故人");
      expect(m.gameDay).toBe(1);
      expect(m.decayFactor).toBe(1.0);
      expect(m.accessCount).toBe(0);
      expect(m.isLongTerm).toBe(false);
    });

    it("可选字段缺省为空数组而非 undefined", () => {
      const mgr = new MemoryManager();
      const m = add(mgr);
      expect(m.relatedCharacters).toEqual([]);
      expect(m.relatedObjects).toEqual([]);
      expect(m.tags).toEqual([]);
    });

    it("写入了数据库", () => {
      const mgr = new MemoryManager();
      const m = add(mgr);
      const found = mgr.getRecentMemories("char_1", 10);
      expect(found.map((x) => x.id)).toContain(m.id);
    });
  });

  describe("retrieveMemories", () => {
    it("没有记忆时返回空数组", () => {
      const mgr = new MemoryManager();
      const r = mgr.retrieveMemories({
        characterId: "char_1",
        currentTime: { day: 1, tick: 0 },
        contextKeywords: [],
      });
      expect(r).toEqual([]);
    });

    it("topK 限制返回条数", () => {
      const mgr = new MemoryManager();
      for (let i = 0; i < 5; i++) add(mgr, { content: `记忆${i}` });
      const r = mgr.retrieveMemories({
        characterId: "char_1",
        currentTime: { day: 1, tick: 10 },
        contextKeywords: [],
        topK: 2,
      });
      expect(r).toHaveLength(2);
    });

    it("关键词匹配的排在前面", () => {
      const mgr = new MemoryManager();
      add(mgr, { content: "今天天气很好" });
      add(mgr, { content: "关于茶馆的对话" });
      const r = mgr.retrieveMemories({
        characterId: "char_1",
        currentTime: { day: 1, tick: 0 },
        contextKeywords: ["茶馆"],
        topK: 5,
      });
      expect(r[0].content).toContain("茶馆");
    });

    it("更近的记忆得分更高（同分情况下靠前）", () => {
      const mgr = new MemoryManager();
      add(mgr, { content: "旧事", day: 1, tick: 0 });
      add(mgr, { content: "近事", day: 1, tick: 90 });
      const r = mgr.retrieveMemories({
        characterId: "char_1",
        currentTime: { day: 1, tick: 100 },
        contextKeywords: [],
        topK: 5,
      });
      expect(r[0].content).toBe("近事");
    });

    it("重要度影响排序", () => {
      const mgr = new MemoryManager();
      add(mgr, { content: "低重要", importance: 1 });
      add(mgr, { content: "高重要", importance: 10 });
      const r = mgr.retrieveMemories({
        characterId: "char_1",
        currentTime: { day: 1, tick: 0 },
        contextKeywords: [],
        topK: 5,
      });
      expect(r[0].content).toBe("高重要");
    });

    it("检索会累加访问次数", () => {
      const mgr = new MemoryManager();
      const m = add(mgr, { content: "会被访问" });
      mgr.retrieveMemories({
        characterId: "char_1",
        currentTime: { day: 1, tick: 0 },
        contextKeywords: [],
        topK: 5,
      });
      const found = mgr.getRecentMemories("char_1", 10).find((x) => x.id === m.id);
      expect(found!.accessCount).toBe(1);
    });

    it("只检索该角色的记忆", () => {
      const mgr = new MemoryManager();
      add(mgr, { characterId: "char_1", content: "我的" });
      add(mgr, { characterId: "char_2", content: "别人的" });
      const r = mgr.retrieveMemories({
        characterId: "char_1",
        currentTime: { day: 1, tick: 0 },
        contextKeywords: [],
        topK: 10,
      });
      expect(r).toHaveLength(1);
      expect(r[0].characterId).toBe("char_1");
    });
  });

  describe("processMemoryConsolidation", () => {
    it("重要度 >= 6 转为长期记忆", () => {
      const mgr = new MemoryManager();
      const m = add(mgr, { importance: 6 });
      mgr.processMemoryConsolidation("char_1");
      const found = mgr.getRecentMemories("char_1", 10).find((x) => x.id === m.id);
      expect(found!.isLongTerm).toBe(true);
    });

    // 已知 BUG（阶段 0 不改业务逻辑，用 it.fails 锁住）：
    // retrieveMemories 从缓存读 accessCount，写回 DB 时用 m.accessCount + 1，
    // 但缓存里的对象没被同步更新 —— 所以每次检索都算成 0 + 1 = 1，
    // accessCount 永远停在 1，processMemoryConsolidation 的
    // `accessCount >= 3` 分支通过正常检索路径永远走不到。
    // 修好之后这个用例会失败，那正是提醒我们摘掉 it.fails 的信号。
    it.fails("访问次数 >= 3 转为长期记忆（已知 bug：accessCount 停在 1）", () => {
      const mgr = new MemoryManager();
      const m = add(mgr, { importance: 1 });
      for (let i = 0; i < 3; i++) {
        mgr.retrieveMemories({
          characterId: "char_1",
          currentTime: { day: 1, tick: 0 },
          contextKeywords: [],
          topK: 1,
        });
      }
      mgr.processMemoryConsolidation("char_1");
      const found = mgr.getRecentMemories("char_1", 10).find((x) => x.id === m.id);
      expect(found!.isLongTerm).toBe(true);
    });

    it("重要度低且未访问的不转长期", () => {
      const mgr = new MemoryManager();
      const m = add(mgr, { importance: 2 });
      mgr.processMemoryConsolidation("char_1");
      const found = mgr.getRecentMemories("char_1", 10).find((x) => x.id === m.id);
      expect(found!.isLongTerm).toBe(false);
    });
  });

  describe("processMemoryDecay", () => {
    it("衰减因子低的旧记忆被标记 faded", () => {
      const mgr = new MemoryManager();
      const m = add(mgr, { importance: 1, day: 1 });
      // 先让衰减因子掉到 0.3 以下
      updateMemory(m.id, { decayFactor: 0.2 });
      mgr.processMemoryDecay("char_1", 5);
      const found = mgr.getRecentMemories("char_1", 10).find((x) => x.id === m.id);
      expect(found!.tags).toContain("faded");
    });

    it("长期记忆不参与衰减", () => {
      const mgr = new MemoryManager();
      const m = add(mgr, { importance: 8, day: 1 });
      mgr.processMemoryConsolidation("char_1");
      mgr.processMemoryDecay("char_1", 30);
      const found = mgr.getRecentMemories("char_1", 10).find((x) => x.id === m.id);
      expect(found!.isLongTerm).toBe(true);
    });
  });

  describe("getRecentHearsay", () => {
    it("只返回说听类记忆", () => {
      const mgr = new MemoryManager();
      add(mgr, { type: "hearsay", content: "听来的" });
      add(mgr, { type: "experience", content: "亲历的" });
      const r = mgr.getRecentHearsay("char_1", 1, 3);
      expect(r.every((m) => m.type === "hearsay")).toBe(true);
    });
  });
});
