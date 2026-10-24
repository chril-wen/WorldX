/**
 * 内存版快照存储 —— 只用于 core 的单测。
 */

import type { GameTime, SnapshotMeta, SnapshotStorage } from "../contracts/index.js";

export class InMemorySnapshotStorage implements SnapshotStorage {
  private rows: SnapshotMeta[] = [];

  createSnapshot(gameTime: GameTime, description?: string): string {
    const id = `snap_${this.rows.length + 1}`;
    this.rows.push({
      id,
      gameDay: gameTime.day,
      gameTick: gameTime.tick,
      description: description ?? "",
      filePath: `/tmp/${id}.db`,
      createdAt: new Date().toISOString(),
    });
    return id;
  }

  restoreSnapshot(snapshotId: string): void {
    if (!this.rows.some((s) => s.id === snapshotId)) {
      throw new Error(`Snapshot not found: ${snapshotId}`);
    }
  }

  listSnapshots(): SnapshotMeta[] {
    return this.rows.map((s) => ({ ...s }));
  }
}
