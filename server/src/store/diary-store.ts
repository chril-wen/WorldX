import { getDb } from "./db.js";
import type { DiaryEntry } from "@worldx/core";

function rowToDiary(row: any): DiaryEntry {
  return {
    id: row.id,
    characterId: row.character_id,
    gameDay: row.game_day,
    content: row.content,
  };
}

export function addDiaryEntry(entry: DiaryEntry): void {
  getDb()
    .prepare(
      `INSERT INTO diary_entries (id, character_id, game_day, content) VALUES (?, ?, ?, ?)`,
    )
    .run(entry.id, entry.characterId, entry.gameDay, entry.content);
}

export function getDiaryEntries(charId: string, gameDay?: number): DiaryEntry[] {
  if (gameDay !== undefined) {
    return (
      getDb()
        .prepare(
          "SELECT * FROM diary_entries WHERE character_id = ? AND game_day = ? ORDER BY rowid",
        )
        .all(charId, gameDay) as any[]
    ).map(rowToDiary);
  }

  return (
    getDb()
      .prepare(
        "SELECT * FROM diary_entries WHERE character_id = ? ORDER BY game_day, rowid",
      )
      .all(charId) as any[]
  ).map(rowToDiary);
}
