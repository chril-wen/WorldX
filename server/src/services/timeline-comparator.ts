import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { GameTime } from "../types/index.js";

/**
 * 对比两条时间线的状态差异。
 *
 * 状态在各自的 state.db 里，事件在各自的 events.jsonl 里。
 * 两条线分叉后跑出不同结果，正是「如果当时那样做会怎样」的答案。
 */

export interface CharacterStateSnapshot {
  characterId: string;
  location: string;
  mainAreaPointId: string | null;
  currentAction: string | null;
  emotionValence: number;
  emotionArousal: number;
  curiosity: number;
}

export interface CharacterDiff {
  characterId: string;
  /** 只有一条线里有的角色标出来 */
  onlyIn: "a" | "b" | null;
  fields: { field: string; a: unknown; b: unknown }[];
}

export interface MemoryDiff {
  characterId: string;
  onlyInA: number;
  onlyInB: number;
  common: number;
  /** 共有记忆里内容不同的条数 */
  diverged: number;
}

export interface TimelineComparison {
  timelineA: { id: string; label?: string; lastGameTime: GameTime; tickCount: number };
  timelineB: { id: string; label?: string; lastGameTime: GameTime; tickCount: number };
  characters: CharacterDiff[];
  memories: MemoryDiff[];
  /** 事件总数差异 */
  eventCounts: { a: number; b: number };
  /** 分叉点（若两条线同源） */
  forkedFrom?: { timelineId: string; snapshotId: string; day: number; tick: number };
}

interface TimelineSnapshotView {
  characters: Map<string, CharacterStateSnapshot>;
  memories: Map<string, { content: string; gameDay: number; gameTick: number }>;
  eventCount: number;
}

function readTimelineView(dbPath: string): TimelineSnapshotView {
  const characters = new Map<string, CharacterStateSnapshot>();
  const memories = new Map<string, { content: string; gameDay: number; gameTick: number }>();
  let eventCount = 0;

  if (!fs.existsSync(dbPath)) {
    return { characters, memories, eventCount };
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    const stateRows = db
      .prepare(
        `SELECT character_id, location, main_area_point_id, current_action,
                emotion_valence, emotion_arousal, curiosity
         FROM character_states`,
      )
      .all() as any[];
    for (const r of stateRows) {
      characters.set(r.character_id, {
        characterId: r.character_id,
        location: r.location,
        mainAreaPointId: r.main_area_point_id ?? null,
        currentAction: r.current_action ?? null,
        emotionValence: Number(r.emotion_valence ?? 0),
        emotionArousal: Number(r.emotion_arousal ?? 0),
        curiosity: Number(r.curiosity ?? 0),
      });
    }

    const memoryRows = db
      .prepare(
        `SELECT id, character_id, content, game_day, game_tick
         FROM memories ORDER BY game_day, game_tick`,
      )
      .all() as any[];
    for (const r of memoryRows) {
      // 记忆的「身份」是内容 —— 同一个 id 在两条线里可能不同，
      // 所以按 内容 + 时间 配对，才能看出「同一条记忆在两条线里变没变」
      const key = `${r.character_id}::${r.game_day}-${r.game_tick}::${r.content}`;
      memories.set(key, {
        content: r.content,
        gameDay: r.game_day,
        gameTick: r.game_tick,
      });
    }

    const countRow = db.prepare("SELECT COUNT(*) AS c FROM events").get() as any;
    eventCount = Number(countRow?.c ?? 0);
  } catch {
    // 库还没建好 —— 当作空视图
  } finally {
    db.close();
  }

  return { characters, memories, eventCount };
}

function diffCharacter(
  id: string,
  a: CharacterStateSnapshot | undefined,
  b: CharacterStateSnapshot | undefined,
): CharacterDiff {
  const fields: { field: string; a: unknown; b: unknown }[] = [];

  if (a && b) {
    const comparisons: [string, unknown, unknown][] = [
      ["location", a.location, b.location],
      ["mainAreaPointId", a.mainAreaPointId, b.mainAreaPointId],
      ["currentAction", a.currentAction, b.currentAction],
      ["emotionValence", a.emotionValence, b.emotionValence],
      ["emotionArousal", a.emotionArousal, b.emotionArousal],
      ["curiosity", a.curiosity, b.curiosity],
    ];
    for (const [field, av, bv] of comparisons) {
      if (av !== bv) fields.push({ field, a: av, b: bv });
    }
  }

  return {
    characterId: id,
    onlyIn: a && !b ? "a" : b && !a ? "b" : null,
    fields,
  };
}

export function compareTimelineStates(
  dbPathA: string,
  dbPathB: string,
  metaA: { id: string; label?: string; lastGameTime: GameTime; tickCount: number },
  metaB: { id: string; label?: string; lastGameTime: GameTime; tickCount: number },
  forkedFrom?: TimelineComparison["forkedFrom"],
): TimelineComparison {
  const viewA = readTimelineView(dbPathA);
  const viewB = readTimelineView(dbPathB);

  const characterIds = new Set<string>([
    ...viewA.characters.keys(),
    ...viewB.characters.keys(),
  ]);
  const characters = [...characterIds]
    .sort()
    .map((id) => diffCharacter(id, viewA.characters.get(id), viewB.characters.get(id)))
    // 只在一条线里出现的角色也算差异，全相同的就滤掉
    .filter((c) => c.onlyIn !== null || c.fields.length > 0);

  // 记忆按角色分组比对
  const byCharacter = new Map<string, { a: Set<string>; b: Set<string> }>();
  const collect = (view: TimelineSnapshotView, side: "a" | "b") => {
    for (const key of view.memories.keys()) {
      const charId = key.split("::")[0];
      if (!byCharacter.has(charId)) byCharacter.set(charId, { a: new Set(), b: new Set() });
      byCharacter.get(charId)![side].add(key);
    }
  };
  collect(viewA, "a");
  collect(viewB, "b");

  const memories: MemoryDiff[] = [...byCharacter.keys()]
    .sort()
    .map((charId) => {
      const setA = byCharacter.get(charId)!.a;
      const setB = byCharacter.get(charId)!.b;
      let onlyInA = 0;
      let onlyInB = 0;
      let common = 0;
      for (const key of setA) {
        if (setB.has(key)) common++;
        else onlyInA++;
      }
      for (const key of setB) {
        if (!setA.has(key)) onlyInB++;
      }
      // 内容相同但时间不同的记忆算「分叉后各自产生的」——
      // 已经在 onlyInA / onlyInB 里体现了
      return {
        characterId: charId,
        onlyInA,
        onlyInB,
        common,
        diverged: 0,
      };
    })
    .filter((m) => m.onlyInA > 0 || m.onlyInB > 0 || m.common > 0);

  return {
    timelineA: metaA,
    timelineB: metaB,
    characters,
    memories,
    eventCounts: { a: viewA.eventCount, b: viewB.eventCount },
    forkedFrom,
  };
}

/** 从时间线目录推断分叉关系 */
export function readForkedFrom(
  timelineDir: string,
): TimelineComparison["forkedFrom"] | undefined {
  const metaPath = path.join(timelineDir, "meta.json");
  if (!fs.existsSync(metaPath)) return undefined;
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    return meta.forkedFrom;
  } catch {
    return undefined;
  }
}
