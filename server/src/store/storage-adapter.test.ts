import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDatabase, closeDb } from "../store/db.js";
import {
  sqliteMemoryStorage,
  sqliteCharacterStateStorage,
  sqliteDiaryStorage,
  createDefaultStorage,
} from "../store/storage-adapter.js";
import { MemoryManager } from "@worldx/core";
import type { MemoryEntry, CharacterState } from "@worldx/core";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "worldx-adapter-test-"));

// 每个用例一个全新的库文件 —— initDatabase 不会清空已有文件。
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

function makeMemory(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: `mem_${Math.random().toString(36).slice(2, 10)}`,
    characterId: "char_1",
    type: "observation",
    content: "在茶馆遇到故人",
    gameDay: 1,
    gameTick: 0,
    importance: 5,
    emotionalValence: 0,
    emotionalIntensity: 3,
    relatedCharacters: [],
    relatedLocation: "tea_house",
    relatedObjects: [],
    tags: [],
    decayFactor: 1.0,
    accessCount: 0,
    isLongTerm: false,
    ...overrides,
  };
}

describe("storage adapter", () => {
  describe("memory storage", () => {
    it("写入后能按角色读回", () => {
      const mem = makeMemory();
      sqliteMemoryStorage.insertMemory(mem);
      const found = sqliteMemoryStorage.getMemoriesByCharacter("char_1");
      expect(found.map((m) => m.id)).toContain(mem.id);
    });

    it("hasMemory 能识别已存在的记忆", () => {
      const mem = makeMemory({ content: "重复检测" });
      sqliteMemoryStorage.insertMemory(mem);
      expect(
        sqliteMemoryStorage.hasMemory("char_1", "observation", "重复检测", 1, 0),
      ).toBe(true);
      expect(
        sqliteMemoryStorage.hasMemory("char_1", "observation", "不存在的", 1, 0),
      ).toBe(false);
    });

    it("按 isLongTerm 过滤", () => {
      sqliteMemoryStorage.insertMemory(makeMemory({ id: "m1", isLongTerm: false }));
      sqliteMemoryStorage.insertMemory(makeMemory({ id: "m2", isLongTerm: true }));
      const shortTerm = sqliteMemoryStorage.getMemoriesByCharacter("char_1", {
        isLongTerm: false,
      });
      expect(shortTerm.map((m) => m.id)).toEqual(["m1"]);
    });

    it("updateMemory 能改字段", () => {
      sqliteMemoryStorage.insertMemory(makeMemory({ id: "m3" }));
      sqliteMemoryStorage.updateMemory("m3", { accessCount: 3, isLongTerm: true });
      const found = sqliteMemoryStorage.getMemoriesByCharacter("char_1");
      const row = found.find((m) => m.id === "m3")!;
      expect(row.accessCount).toBe(3);
      expect(row.isLongTerm).toBe(true);
    });

    it("deleteMemory 真的删掉", () => {
      sqliteMemoryStorage.insertMemory(makeMemory({ id: "m4" }));
      sqliteMemoryStorage.deleteMemory("m4");
      expect(
        sqliteMemoryStorage.getMemoriesByCharacter("char_1").map((m) => m.id),
      ).not.toContain("m4");
    });

    it("limit 生效", () => {
      for (let i = 0; i < 5; i++) {
        sqliteMemoryStorage.insertMemory(makeMemory({ id: `lim_${i}` }));
      }
      expect(
        sqliteMemoryStorage.getMemoriesByCharacter("char_1", { limit: 2 }),
      ).toHaveLength(2);
    });
  });

  describe("character state storage", () => {
    const state: CharacterState = {
      characterId: "char_1",
      location: "main_area",
      mainAreaPointId: null,
      currentAction: null,
      currentActionTarget: null,
      actionStartTick: 0,
      actionEndTick: 0,
      emotionValence: 1,
      emotionArousal: 3,
      curiosity: 50,
      dailyPlan: null,
    };

    it("init 之后能读回", () => {
      sqliteCharacterStateStorage.initCharacterState(state);
      expect(sqliteCharacterStateStorage.getCharacterState("char_1").location).toBe(
        "main_area",
      );
    });

    it("update 能改状态", () => {
      sqliteCharacterStateStorage.initCharacterState(state);
      sqliteCharacterStateStorage.updateCharacterState("char_1", {
        emotionArousal: 8,
        location: "tea_house",
      });
      const got = sqliteCharacterStateStorage.getCharacterState("char_1");
      expect(got.emotionArousal).toBe(8);
      expect(got.location).toBe("tea_house");
    });

    it("按位置查角色", () => {
      sqliteCharacterStateStorage.initCharacterState(state);
      sqliteCharacterStateStorage.initCharacterState({
        ...state,
        characterId: "char_2",
        location: "tea_house",
      });
      expect(
        sqliteCharacterStateStorage.getCharactersByLocation("tea_house").map(
          (s) => s.characterId,
        ),
      ).toEqual(["char_2"]);
    });
  });

  describe("diary storage", () => {
    it("写入后能按天读回", () => {
      sqliteDiaryStorage.addDiaryEntry({
        id: "d1",
        characterId: "char_1",
        gameDay: 3,
        content: "今天很平静",
      });
      expect(sqliteDiaryStorage.getDiaryEntries("char_1", 3)).toHaveLength(1);
      expect(sqliteDiaryStorage.getDiaryEntries("char_1", 4)).toHaveLength(0);
    });

    it("不指定天时返回全部", () => {
      sqliteDiaryStorage.addDiaryEntry({
        id: "d1",
        characterId: "char_1",
        gameDay: 3,
        content: "第一天",
      });
      sqliteDiaryStorage.addDiaryEntry({
        id: "d2",
        characterId: "char_1",
        gameDay: 4,
        content: "第二天",
      });
      expect(sqliteDiaryStorage.getDiaryEntries("char_1")).toHaveLength(2);
    });
  });

  describe("MemoryManager 走 SQLite adapter", () => {
    it("存取闭环正常", () => {
      const mgr = new MemoryManager(sqliteMemoryStorage);
      const m = mgr.addMemory({
        characterId: "char_1",
        type: "observation",
        content: "在茶馆遇到故人",
        gameTime: { day: 1, tick: 0 },
        importance: 5,
        emotionalValence: 0,
        emotionalIntensity: 3,
      });
      expect(mgr.getRecentMemories("char_1", 10).map((x) => x.id)).toContain(m.id);

      mgr.retrieveMemories({
        characterId: "char_1",
        currentTime: { day: 1, tick: 0 },
        contextKeywords: [],
        topK: 5,
      });
      const found = mgr.getRecentMemories("char_1", 10).find((x) => x.id === m.id)!;
      expect(found.accessCount).toBe(1);
    });
  });

  describe("createDefaultStorage", () => {
    it("三块能力都齐", () => {
      const storage = createDefaultStorage();
      expect(storage.memories).toBeDefined();
      expect(storage.characterStates).toBeDefined();
      expect(storage.diaries).toBeDefined();
    });
  });
});
