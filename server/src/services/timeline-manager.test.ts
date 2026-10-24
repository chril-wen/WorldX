import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TimelineManager, type TimelineFrame } from "../services/timeline-manager.js";
import {
  createTimelineSnapshot,
  listTimelineSnapshots,
  deleteTimelineSnapshot,
  restoreTimelineSnapshot,
} from "../store/snapshot-store.js";
import { initDatabase, closeDb, getDb } from "../store/db.js";
import Database from "better-sqlite3";

/**
 * 分叉是阶段 7 的核心，也是最容易出错的地方。
 *
 * 核心风险：state.db 复制了、events.jsonl 没截断 →
 * 「状态是分叉后的，事件是分叉前的」→ 回放时不一致。
 * 所以这些用例重点盯住三样东西的一致性：
 *   1. DB 里的事件集合
 *   2. events.jsonl 里的事件集合
 *   3. 两者必须完全相同
 */

let tmpDir: string;
let worldDir: string;
let tm: TimelineManager;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "worldx-fork-test-"));
  worldDir = path.join(tmpDir, "world_1");
  fs.mkdirSync(path.join(worldDir, "timelines"), { recursive: true });
  tm = new TimelineManager();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 建一条时间线，带真实的 state.db 和 events.jsonl */
function makeTimeline(
  id: string,
  ticks: { day: number; tick: number; events: { gameDay: number; gameTick: number; id: string }[] }[],
): string {
  const dir = tm.getTimelineDir(worldDir, id);
  fs.mkdirSync(dir, { recursive: true });

  const dbPath = tm.getTimelineDbPath(worldDir, id);
  initDatabase(dbPath);

  // 写几个事件 + 角色状态 + 记忆
  const db = getDb();
  for (const t of ticks) {
    for (const e of t.events) {
      db.prepare(
        `INSERT INTO events (id, game_day, game_tick, type, actor_id, location, data)
         VALUES (?, ?, ?, 'action_start', 'char_1', 'main_area', '{}')`,
      ).run(e.id, e.gameDay, e.gameTick);
    }
  }
  db.prepare(
    `INSERT INTO character_states (character_id, location, emotion_valence, emotion_arousal)
     VALUES ('char_1', 'main_area', 1.5, 3.0)`,
  ).run();
  db.prepare(
    `INSERT INTO memories (id, character_id, type, content, game_day, game_tick, importance)
     VALUES ('mem_1', 'char_1', 'observation', '记得茶馆的雨', 1, 1, 5)`,
  ).run();
  db.prepare(
    `INSERT INTO world_global_state (key, value) VALUES ('current_day', '1')`,
  ).run();
  db.prepare(
    `INSERT INTO world_global_state (key, value) VALUES ('current_tick', '4')`,
  ).run();
  closeDb();

  writeEventsJsonl(id, ticks);
  writeMeta(id, ticks.length);

  return id;
}

/** 追加 tick 帧到 events.jsonl（模拟世界继续跑） */
function appendTicks(
  id: string,
  ticks: { day: number; tick: number; events: { gameDay: number; gameTick: number; id: string }[] }[],
): void {
  const p = tm.getTimelineEventsPath(worldDir, id);
  const existing = fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : "";
  const lines = ticks.map((t) =>
    JSON.stringify({
      type: "tick",
      gameTime: { day: t.day, tick: t.tick },
      events: t.events,
    }),
  );
  fs.writeFileSync(p, existing + lines.join("\n") + "\n", "utf-8");
}

/** 往 state.db 追加事件（模拟世界继续跑，DB 跟着长） */
function appendDbEvents(
  id: string,
  events: { gameDay: number; gameTick: number; id: string }[],
): void {
  initDatabase(tm.getTimelineDbPath(worldDir, id));
  const db = getDb();
  for (const e of events) {
    db.prepare(
      `INSERT INTO events (id, game_day, game_tick, type, actor_id, location, data)
       VALUES (?, ?, ?, 'action_start', 'char_1', 'main_area', '{}')`,
    ).run(e.id, e.gameDay, e.gameTick);
  }
  closeDb();
}

function writeEventsJsonl(
  id: string,
  ticks: { day: number; tick: number; events: { gameDay: number; gameTick: number; id: string }[] }[],
): void {
  const lines: string[] = [
    JSON.stringify({
      type: "init",
      gameTime: { day: 1, tick: 0 },
      characters: [{ id: "char_1", name: "沈四娘", location: "main_area", mainAreaPointId: null }],
    }),
  ];
  for (const t of ticks) {
    lines.push(
      JSON.stringify({
        type: "tick",
        gameTime: { day: t.day, tick: t.tick },
        events: t.events,
      }),
    );
  }
  fs.writeFileSync(tm.getTimelineEventsPath(worldDir, id), lines.join("\n") + "\n", "utf-8");
}

function writeMeta(id: string, tickCount: number): void {
  fs.writeFileSync(
    path.join(tm.getTimelineDir(worldDir, id), "meta.json"),
    JSON.stringify({
      id,
      worldId: "world_1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastGameTime: { day: 1, tick: tickCount },
      tickCount,
      status: "stopped",
    }),
  );
}

function readEventsJsonl(timelineId: string): TimelineFrame[] {
  const p = tm.getTimelineEventsPath(worldDir, timelineId);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as TimelineFrame);
}

function jsonlEventIds(timelineId: string): string[] {
  const out: string[] = [];
  for (const f of readEventsJsonl(timelineId)) {
    if (f.type === "tick") for (const e of f.events as any[]) out.push(e.id);
  }
  return out;
}

function dbEventIds(timelineId: string): string[] {
  const dbPath = tm.getTimelineDbPath(worldDir, timelineId);
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare("SELECT id FROM events ORDER BY rowid").all().map((r: any) => r.id);
  } finally {
    db.close();
  }
}

const TICKS = [
  { day: 1, tick: 1, events: [{ gameDay: 1, gameTick: 1, id: "e1" }] },
  { day: 1, tick: 2, events: [{ gameDay: 1, gameTick: 2, id: "e2" }] },
  { day: 1, tick: 3, events: [{ gameDay: 1, gameTick: 3, id: "e3" }] },
  { day: 1, tick: 4, events: [{ gameDay: 1, gameTick: 4, id: "e4" }] },
];

describe("TimelineManager · 分叉", () => {
  describe("truncateEventsToTick", () => {
    it("只保留分叉点之前的事件", () => {
      const id = makeTimeline("tl-a", TICKS);
      tm.truncateEventsToTick(worldDir, id, 1, 2);
      expect(jsonlEventIds(id)).toEqual(["e1", "e2"]);
    });

    it("保留 init 帧", () => {
      const id = makeTimeline("tl-a", TICKS);
      tm.truncateEventsToTick(worldDir, id, 1, 2);
      const frames = readEventsJsonl(id);
      expect(frames[0].type).toBe("init");
    });

    it("分叉点在最后则不丢事件", () => {
      const id = makeTimeline("tl-a", TICKS);
      tm.truncateEventsToTick(worldDir, id, 1, 4);
      expect(jsonlEventIds(id)).toEqual(["e1", "e2", "e3", "e4"]);
    });

    it("分叉点在最前则只留 init", () => {
      const id = makeTimeline("tl-a", TICKS);
      tm.truncateEventsToTick(worldDir, id, 1, 0);
      expect(jsonlEventIds(id)).toEqual([]);
      expect(readEventsJsonl(id)[0].type).toBe("init");
    });

    it("按事件自身的时间戳截断，不按帧标签", () => {
      // 关键场景：一帧里装着多个 tick 的事件（批量模拟时会这样）
      // 帧标签是「这批跑完之后的时间」，比里面最后一个事件还大。
      const dir = tm.getTimelineDir(worldDir, "tl-b");
      fs.mkdirSync(dir, { recursive: true });
      initDatabase(tm.getTimelineDbPath(worldDir, "tl-b"));
      closeDb();

      const lines = [
        JSON.stringify({ type: "init", gameTime: { day: 1, tick: 0 }, characters: [] }),
        // 这一帧标签是 tick=10，里面却是 tick 3,4,5 的事件
        JSON.stringify({
          type: "tick",
          gameTime: { day: 1, tick: 10 },
          events: [
            { gameDay: 1, gameTick: 3, id: "x3" },
            { gameDay: 1, gameTick: 4, id: "x4" },
            { gameDay: 1, gameTick: 5, id: "x5" },
          ],
        }),
      ];
      fs.writeFileSync(tm.getTimelineEventsPath(worldDir, "tl-b"), lines.join("\n") + "\n");

      tm.truncateEventsToTick(worldDir, "tl-b", 1, 4);
      // 应该只留 tick 3 和 4 的事件 —— 如果按帧标签截，这一帧会被整个丢掉
      expect(jsonlEventIds("tl-b")).toEqual(["x3", "x4"]);
    });

    it("截断后帧标签改成帧内最大的事件 tick", () => {
      const dir = tm.getTimelineDir(worldDir, "tl-c");
      fs.mkdirSync(dir, { recursive: true });
      initDatabase(tm.getTimelineDbPath(worldDir, "tl-c"));
      closeDb();

      const lines = [
        JSON.stringify({ type: "init", gameTime: { day: 1, tick: 0 }, characters: [] }),
        JSON.stringify({
          type: "tick",
          gameTime: { day: 1, tick: 10 },
          events: [
            { gameDay: 1, gameTick: 3, id: "y3" },
            { gameDay: 1, gameTick: 4, id: "y4" },
            { gameDay: 1, gameTick: 5, id: "y5" },
          ],
        }),
      ];
      fs.writeFileSync(tm.getTimelineEventsPath(worldDir, "tl-c"), lines.join("\n") + "\n");

      tm.truncateEventsToTick(worldDir, "tl-c", 1, 4);
      const frames = readEventsJsonl("tl-c");
      const tickFrame = frames.find((f) => f.type === "tick") as any;
      expect(tickFrame.gameTime).toEqual({ day: 1, tick: 4 });
    });

    it("整帧在范围内时保留原标签", () => {
      const id = makeTimeline("tl-a", TICKS);
      tm.truncateEventsToTick(worldDir, id, 1, 4);
      const frames = readEventsJsonl(id);
      const tickFrames = frames.filter((f) => f.type === "tick") as any[];
      expect(tickFrames).toHaveLength(4);
      // 每帧的标签都还是它自己的标签，没被改写
      expect(tickFrames.map((f) => f.gameTime)).toEqual([
        { day: 1, tick: 1 },
        { day: 1, tick: 2 },
        { day: 1, tick: 3 },
        { day: 1, tick: 4 },
      ]);
    });

    it("跨天分叉：保留前一天的，回掉后面的", () => {
      const mixed = [
        { day: 1, tick: 1, events: [{ gameDay: 1, gameTick: 1, id: "d1" }] },
        { day: 1, tick: 2, events: [{ gameDay: 1, gameTick: 2, id: "d2" }] },
        { day: 2, tick: 1, events: [{ gameDay: 2, gameTick: 1, id: "d3" }] },
        { day: 2, tick: 2, events: [{ gameDay: 2, gameTick: 2, id: "d4" }] },
      ];
      const id = makeTimeline("tl-d", mixed);
      tm.truncateEventsToTick(worldDir, id, 2, 1);
      expect(jsonlEventIds(id)).toEqual(["d1", "d2", "d3"]);
    });
  });

  describe("forkFromSnapshot", () => {
    it("新时间线的 id 与源不同", () => {
      const src = makeTimeline("tl-src", TICKS);
      const snapId = createTimelineSnapshot(
        { dir: tm.getTimelineDir(worldDir, src), dbPath: tm.getTimelineDbPath(worldDir, src) },
        { day: 1, tick: 2 },
        "测试快照",
      );
      const newId = tm.forkFromSnapshot(worldDir, src, snapId);
      expect(newId).not.toBe(src);
      expect(newId).toContain("fork");
    });

    it("meta.json 记录 forkedFrom", () => {
      const src = makeTimeline("tl-src", TICKS);
      const snapId = createTimelineSnapshot(
        { dir: tm.getTimelineDir(worldDir, src), dbPath: tm.getTimelineDbPath(worldDir, src) },
        { day: 1, tick: 2 },
        "测试快照",
      );
      const newId = tm.forkFromSnapshot(worldDir, src, snapId, "如果当时没问陆先生");
      const meta = JSON.parse(
        fs.readFileSync(path.join(tm.getTimelineDir(worldDir, newId), "meta.json"), "utf-8"),
      );
      expect(meta.forkedFrom.timelineId).toBe(src);
      expect(meta.forkedFrom.snapshotId).toBe(snapId);
      expect(meta.forkedFrom.day).toBe(1);
      expect(meta.forkedFrom.tick).toBe(2);
      expect(meta.label).toBe("如果当时没问陆先生");
    });

    it("新时间线的 state.db 存在", () => {
      const src = makeTimeline("tl-src", TICKS);
      const snapId = createTimelineSnapshot(
        { dir: tm.getTimelineDir(worldDir, src), dbPath: tm.getTimelineDbPath(worldDir, src) },
        { day: 1, tick: 2 },
        "",
      );
      const newId = tm.forkFromSnapshot(worldDir, src, snapId);
      expect(fs.existsSync(tm.getTimelineDbPath(worldDir, newId))).toBe(true);
    });

    it("分叉点的状态来自快照", () => {
      const src = makeTimeline("tl-src", TICKS);
      // 快照之后再写点东西进源库，分叉出的应该还是快照时的状态
      const snapId = createTimelineSnapshot(
        { dir: tm.getTimelineDir(worldDir, src), dbPath: tm.getTimelineDbPath(worldDir, src) },
        { day: 1, tick: 2 },
        "",
      );
      initDatabase(tm.getTimelineDbPath(worldDir, src));
          getDb()
        .prepare("UPDATE character_states SET emotion_valence = 99 WHERE character_id = 'char_1'")
        .run();
      closeDb();

      const newId = tm.forkFromSnapshot(worldDir, src, snapId);
          const db = new Database(tm.getTimelineDbPath(worldDir, newId), { readonly: true });
      try {
        const row = db
          .prepare("SELECT emotion_valence FROM character_states WHERE character_id = 'char_1'")
          .get() as any;
        expect(row.emotion_valence).toBe(1.5);
      } finally {
        db.close();
      }
    });

    it("事件流被截断到分叉点", () => {
      const src = makeTimeline("tl-src", TICKS);
      const snapId = createTimelineSnapshot(
        { dir: tm.getTimelineDir(worldDir, src), dbPath: tm.getTimelineDbPath(worldDir, src) },
        { day: 1, tick: 2 },
        "",
      );
      const newId = tm.forkFromSnapshot(worldDir, src, snapId);
      expect(jsonlEventIds(newId)).toEqual(["e1", "e2"]);
    });

    it("源时间线不被改动", () => {
      const src = makeTimeline("tl-src", TICKS);
      const snapId = createTimelineSnapshot(
        { dir: tm.getTimelineDir(worldDir, src), dbPath: tm.getTimelineDbPath(worldDir, src) },
        { day: 1, tick: 2 },
        "",
      );
      tm.forkFromSnapshot(worldDir, src, snapId);
      expect(jsonlEventIds(src)).toEqual(["e1", "e2", "e3", "e4"]);
    });

    it("DB 与 events.jsonl 的事件集合一致 —— 这是分叉正确性的核心", () => {
      // 真实场景：世界跑到 tick 2 时打了快照，然后**继续跑**到 tick 4，
      // 这时再从那个快照分叉。
      // 分叉出的时间线必须回到 tick 2 的状态 —— DB 和事件流都要回到 tick 2。
      const src = makeTimeline("tl-src", TICKS.slice(0, 2));
      const snapId = createTimelineSnapshot(
        { dir: tm.getTimelineDir(worldDir, src), dbPath: tm.getTimelineDbPath(worldDir, src) },
        { day: 1, tick: 2 },
        "",
      );

      // 世界继续跑
      appendTicks("tl-src", TICKS.slice(2));
      appendDbEvents("tl-src", [
        { gameDay: 1, gameTick: 3, id: "e3" },
        { gameDay: 1, gameTick: 4, id: "e4" },
      ]);

      const newId = tm.forkFromSnapshot(worldDir, src, snapId);

      // 分叉出的时间线：DB 和事件流都停在 tick 2
      expect(dbEventIds(newId)).toEqual(["e1", "e2"]);
      expect(jsonlEventIds(newId)).toEqual(["e1", "e2"]);

      // 两边集合相同 —— 不存在「状态是分叉后的，事件是分叉前的」
      expect([...dbEventIds(newId)].sort()).toEqual([...jsonlEventIds(newId)].sort());
    });

    it("分叉点之后的记忆不会出现在新时间线里", () => {
      const src = makeTimeline("tl-src", TICKS.slice(0, 2));
      const snapId = createTimelineSnapshot(
        { dir: tm.getTimelineDir(worldDir, src), dbPath: tm.getTimelineDbPath(worldDir, src) },
        { day: 1, tick: 2 },
        "",
      );

      // 快照之后再产生一条记忆
      initDatabase(tm.getTimelineDbPath(worldDir, src));
      getDb()
        .prepare(
          `INSERT INTO memories (id, character_id, type, content, game_day, game_tick, importance)
           VALUES ('mem_late', 'char_1', 'observation', '分叉之后才想起的事', 1, 4, 5)`,
        )
        .run();
      closeDb();

      const newId = tm.forkFromSnapshot(worldDir, src, snapId);
      const db = new Database(tm.getTimelineDbPath(worldDir, newId), { readonly: true });
      try {
        const rows = db.prepare("SELECT content FROM memories").all() as any[];
        expect(rows.map((r) => r.content)).toEqual(["记得茶馆的雨"]);
      } finally {
        db.close();
      }
    });

    it("分叉出的时间线出现在列表里", () => {
      const src = makeTimeline("tl-src", TICKS);
      const snapId = createTimelineSnapshot(
        { dir: tm.getTimelineDir(worldDir, src), dbPath: tm.getTimelineDbPath(worldDir, src) },
        { day: 1, tick: 2 },
        "",
      );
      const newId = tm.forkFromSnapshot(worldDir, src, snapId);
      const ids = tm.listTimelines(worldDir).map((t) => t.id);
      expect(ids).toContain(src);
      expect(ids).toContain(newId);
    });

    it("快照不存在时抛错", () => {
      makeTimeline("tl-src", TICKS);
      expect(() => tm.forkFromSnapshot(worldDir, "tl-src", "不存在的快照")).toThrow(
        /Snapshot not found/,
      );
    });

    it("源时间线不存在时抛错", () => {
      expect(() => tm.forkFromSnapshot(worldDir, "不存在", "x")).toThrow(/Timeline not found/);
    });
  });

  describe("快照 CRUD", () => {
    it("创建后能列出来", () => {
      const src = makeTimeline("tl-src", TICKS);
      const target = {
        dir: tm.getTimelineDir(worldDir, src),
        dbPath: tm.getTimelineDbPath(worldDir, src),
      };
      const id = createTimelineSnapshot(target, { day: 1, tick: 3 }, "手动快照");
      const list = listTimelineSnapshots(target);
      expect(list.length).toBe(1);
      expect(list[0].id).toBe(id);
      expect(list[0].description).toBe("手动快照");
      expect(list[0].gameDay).toBe(1);
      expect(list[0].gameTick).toBe(3);
    });

    it("删除后列表里没有了，文件也没了", () => {
      const src = makeTimeline("tl-src", TICKS);
      const target = {
        dir: tm.getTimelineDir(worldDir, src),
        dbPath: tm.getTimelineDbPath(worldDir, src),
      };
      const id = createTimelineSnapshot(target, { day: 1, tick: 3 }, "");
      const filePath = listTimelineSnapshots(target)[0].filePath;
      expect(fs.existsSync(filePath)).toBe(true);

      expect(deleteTimelineSnapshot(target, id)).toBe(true);
      expect(listTimelineSnapshots(target)).toHaveLength(0);
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it("删除不存在的快照返回 false", () => {
      const src = makeTimeline("tl-src", TICKS);
      const target = {
        dir: tm.getTimelineDir(worldDir, src),
        dbPath: tm.getTimelineDbPath(worldDir, src),
      };
      expect(deleteTimelineSnapshot(target, "不存在")).toBe(false);
    });

    it("恢复到快照会还原状态", () => {
      const src = makeTimeline("tl-src", TICKS);
      const target = {
        dir: tm.getTimelineDir(worldDir, src),
        dbPath: tm.getTimelineDbPath(worldDir, src),
      };
      const snapId = createTimelineSnapshot(target, { day: 1, tick: 2 }, "");

      // 改一下状态
      initDatabase(target.dbPath);
          getDb()
        .prepare("UPDATE character_states SET emotion_valence = 42 WHERE character_id = 'char_1'")
        .run();
      closeDb();

      restoreTimelineSnapshot(target, snapId);

          const db = new Database(target.dbPath, { readonly: true });
      try {
        const row = db
          .prepare("SELECT emotion_valence FROM character_states WHERE character_id = 'char_1'")
          .get() as any;
        expect(row.emotion_valence).toBe(1.5);
      } finally {
        db.close();
      }
    });
  });
});
