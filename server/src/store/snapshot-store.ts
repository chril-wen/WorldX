import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { getDb, getDbPath, closeDb, initDatabase } from "./db.js";
import type { GameTime } from "../types/index.js";
import { generateId } from "../utils/id-generator.js";

export interface SnapshotMeta {
  id: string;
  gameDay: number;
  gameTick: number;
  description: string;
  filePath: string;
  createdAt: string;
}

/**
 * 时间线作用域的快照目标。
 *
 * 全局连接（getDb()）指向的是**当前**时间线的 state.db。要操作别的
 * 时间线必须开独立连接 —— WAL 模式下同一文件开两个连接是安全的。
 */
export interface TimelineSnapshotTarget {
  /** 时间线目录（<worldDir>/timelines/<id>） */
  dir: string;
  /** 时间线的 state.db 路径 */
  dbPath: string;
}

function getSnapshotsDir(): string {
  try {
    return path.join(path.dirname(getDbPath()), "snapshots");
  } catch {
    return path.resolve("data/snapshots");
  }
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function rowToSnapshotMeta(r: any): SnapshotMeta {
  return {
    id: r.id,
    gameDay: r.game_day,
    gameTick: r.game_tick,
    description: r.description,
    filePath: r.file_path,
    createdAt: r.created_at,
  };
}

/** 打开某条时间线的库。独立连接，不动全局连接。 */
function openTimelineDb(dbPath: string): Database.Database {
  return new Database(dbPath);
}

export function createSnapshot(gameTime: GameTime, description?: string): string {
  const SNAPSHOTS_DIR = getSnapshotsDir();
  ensureDir(SNAPSHOTS_DIR);

  const id = generateId();
  const fileName = `snapshot_${gameTime.day}_${gameTime.tick}_${id}.db`;
  const filePath = path.join(SNAPSHOTS_DIR, fileName);

  const db = getDb();
  db.pragma("wal_checkpoint(TRUNCATE)");

  fs.copyFileSync(getDbPath(), filePath);

  db.prepare(
    `INSERT INTO snapshots (id, game_day, game_tick, description, file_path) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, gameTime.day, gameTime.tick, description ?? "", filePath);

  return id;
}

export function listSnapshots(): SnapshotMeta[] {
  return (
    getDb().prepare("SELECT * FROM snapshots ORDER BY created_at DESC").all() as any[]
  ).map((r) => ({
    id: r.id,
    gameDay: r.game_day,
    gameTick: r.game_tick,
    description: r.description,
    filePath: r.file_path,
    createdAt: r.created_at,
  }));
}

export function restoreSnapshot(snapshotId: string): void {
  const db = getDb();
  const row = db.prepare("SELECT * FROM snapshots WHERE id = ?").get(snapshotId) as any;
  if (!row) throw new Error(`Snapshot not found: ${snapshotId}`);

  const dbPath = getDbPath();
  const snapshotPath: string = row.file_path;

  if (!fs.existsSync(snapshotPath)) {
    throw new Error(`Snapshot file not found: ${snapshotPath}`);
  }

  closeDb();

  for (const suffix of ["-wal", "-shm"]) {
    const f = dbPath + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }

  fs.copyFileSync(snapshotPath, dbPath);
  initDatabase(dbPath);
}

export function deleteSnapshot(snapshotId: string): void {
  const db = getDb();
  const row = db.prepare("SELECT file_path FROM snapshots WHERE id = ?").get(snapshotId) as
    | { file_path: string }
    | undefined;
  if (!row) return;

  if (fs.existsSync(row.file_path)) fs.unlinkSync(row.file_path);
  db.prepare("DELETE FROM snapshots WHERE id = ?").run(snapshotId);
}

export function createBranch(snapshotId: string, branchName: string): string {
  const db = getDb();
  const row = db.prepare("SELECT file_path FROM snapshots WHERE id = ?").get(snapshotId) as
    | { file_path: string }
    | undefined;
  if (!row) throw new Error(`Snapshot not found: ${snapshotId}`);
  if (!fs.existsSync(row.file_path)) {
    throw new Error(`Snapshot file not found: ${row.file_path}`);
  }

  const branchDir = path.resolve("data/branches");
  ensureDir(branchDir);

  const branchPath = path.join(branchDir, `${branchName}.db`);
  fs.copyFileSync(row.file_path, branchPath);
  return branchPath;
}

// ─── 时间线作用域的快照 ─────────────────────────────────────────────────────
//
// 上面的 createSnapshot / listSnapshots 走全局连接，只能操作**当前**时间线。
// 阶段 7 要能「给任意一条时间线打快照」，所以下面这组函数接收显式的
// 时间线目标，开独立连接操作 —— 不碰全局连接，也不影响正在跑的模拟。

/** 给指定时间线打快照。返回快照 id。 */
export function createTimelineSnapshot(
  target: TimelineSnapshotTarget,
  gameTime: GameTime,
  description?: string,
): string {
  const snapshotsDir = path.join(target.dir, "snapshots");
  ensureDir(snapshotsDir);

  const id = generateId();
  const fileName = `snapshot_${gameTime.day}_${gameTime.tick}_${id}.db`;
  const filePath = path.join(snapshotsDir, fileName);

  const db = openTimelineDb(target.dbPath);
  try {
    // 复制前先把 WAL 落盘 —— 否则 state.db 里可能缺最新的事务
    db.pragma("wal_checkpoint(TRUNCATE)");
    fs.copyFileSync(target.dbPath, filePath);

    db.prepare(
      `INSERT INTO snapshots (id, game_day, game_tick, description, file_path) VALUES (?, ?, ?, ?, ?)`,
    ).run(id, gameTime.day, gameTime.tick, description ?? "", filePath);
  } finally {
    db.close();
  }

  return id;
}

/** 列出某条时间线的全部快照。 */
export function listTimelineSnapshots(
  target: TimelineSnapshotTarget,
): SnapshotMeta[] {
  if (!fs.existsSync(target.dbPath)) return [];

  const db = openTimelineDb(target.dbPath);
  try {
    const rows = db
      .prepare("SELECT * FROM snapshots ORDER BY created_at DESC")
      .all() as any[];
    return rows.map(rowToSnapshotMeta);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** 取某个快照的元信息（跨时间线）。 */
export function getTimelineSnapshot(
  target: TimelineSnapshotTarget,
  snapshotId: string,
): SnapshotMeta | null {
  if (!fs.existsSync(target.dbPath)) return null;

  const db = openTimelineDb(target.dbPath);
  try {
    const row = db.prepare("SELECT * FROM snapshots WHERE id = ?").get(snapshotId) as any;
    return row ? rowToSnapshotMeta(row) : null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/**
 * 删除某个快照：文件 + 登记行，两边都要清。
 * 注意只删登记行会留下孤儿文件（占磁盘）；只删文件会让列表里出现坏条目。
 */
export function deleteTimelineSnapshot(
  target: TimelineSnapshotTarget,
  snapshotId: string,
): boolean {
  const meta = getTimelineSnapshot(target, snapshotId);
  if (!meta) return false;

  const db = openTimelineDb(target.dbPath);
  try {
    db.prepare("DELETE FROM snapshots WHERE id = ?").run(snapshotId);
  } finally {
    db.close();
  }

  if (meta.filePath && fs.existsSync(meta.filePath)) {
    fs.unlinkSync(meta.filePath);
  }
  return true;
}

/**
 * 把某条时间线的状态恢复到某个快照。
 *
 * 恢复的是**那条时间线自己的** state.db —— 不是当前连接指向的那个。
 * 当前正在跑的时间线不会被这次恢复影响（除非它就是被恢复的那条，
 * 那时由调用方决定要不要重载）。
 */
export function restoreTimelineSnapshot(
  target: TimelineSnapshotTarget,
  snapshotId: string,
): void {
  const meta = getTimelineSnapshot(target, snapshotId);
  if (!meta) throw new Error(`Snapshot not found: ${snapshotId}`);
  if (!fs.existsSync(meta.filePath)) {
    throw new Error(`Snapshot file not found: ${meta.filePath}`);
  }

  // WAL 的附属文件必须一起清掉，否则旧事务会盖回新状态
  for (const suffix of ["-wal", "-shm"]) {
    const f = target.dbPath + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }

  fs.copyFileSync(meta.filePath, target.dbPath);
}

