import fs from "node:fs";
import path from "node:path";
import type { GameTime, SimulationEvent } from "../types/index.js";
import { listAllWorlds } from "../utils/world-directories.js";
import { getTimelineSnapshot, restoreTimelineSnapshot } from "../store/snapshot-store.js";

export interface TimelineMeta {
  id: string;
  worldId: string;
  createdAt: string;
  updatedAt: string;
  lastGameTime: GameTime;
  tickCount: number;
  status: "recording" | "stopped";
  /** 分叉来源 —— 这条时间线是从哪条时间线的哪个快照分出来的 */
  forkedFrom?: {
    timelineId: string;
    snapshotId: string;
    tick: number;
    day: number;
  };
  /** 人类可读的标签（分叉时用来区分「如果当时那样做」） */
  label?: string;
}

export interface InitFrameCharacter {
  id: string;
  name: string;
  location: string;
  mainAreaPointId: string | null;
}

export interface TimelineInitFrame {
  type: "init";
  gameTime: GameTime;
  characters: InitFrameCharacter[];
}

export interface TimelineTickFrame {
  type: "tick";
  gameTime: GameTime;
  events: any[];
}

export type TimelineFrame = TimelineInitFrame | TimelineTickFrame;

const TIMELINES_DIR_NAME = "timelines";

function generateTimelineId(): string {
  const now = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `tl-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export class TimelineManager {
  private worldDir: string | null = null;
  private currentTimelineId: string | null = null;
  private eventStream: fs.WriteStream | null = null;
  private tickCount = 0;

  /**
   * Resolve (or create) a timeline for the given world directory.
   * If timelineId is provided and exists, use it; otherwise pick the latest or create new.
   * Returns the resolved timeline ID.
   */
  initialize(worldDir: string, timelineId?: string): string {
    this.worldDir = worldDir;

    if (timelineId) {
      const dir = this.getTimelineDir(worldDir, timelineId);
      if (fs.existsSync(dir) && fs.existsSync(path.join(dir, "meta.json"))) {
        this.currentTimelineId = timelineId;
        this.tickCount = this.readMeta(worldDir, timelineId).tickCount;
        return timelineId;
      }
    }

    const timelines = this.listTimelines(worldDir);
    if (timelines.length > 0) {
      const latest = timelines[0];
      this.currentTimelineId = latest.id;
      this.tickCount = latest.tickCount;
      return latest.id;
    }

    return this.createTimeline(worldDir);
  }

  createTimeline(worldDir: string): string {
    const id = generateTimelineId();
    const dir = this.getTimelineDir(worldDir, id);
    fs.mkdirSync(dir, { recursive: true });

    const worldId = path.basename(worldDir);
    const meta: TimelineMeta = {
      id,
      worldId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastGameTime: { day: 1, tick: 0 },
      tickCount: 0,
      status: "recording",
    };
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));

    this.worldDir = worldDir;
    this.currentTimelineId = id;
    this.tickCount = 0;
    return id;
  }

  startRecording(characters: InitFrameCharacter[]): void {
    if (!this.worldDir || !this.currentTimelineId) return;

    const eventsPath = this.getCurrentEventsPath();
    if (!eventsPath) return;

    const isNewFile = !fs.existsSync(eventsPath) || fs.statSync(eventsPath).size === 0;

    this.eventStream = fs.createWriteStream(eventsPath, { flags: "a" });

    if (isNewFile) {
      const initFrame: TimelineInitFrame = {
        type: "init",
        gameTime: { day: 1, tick: 0 },
        characters,
      };
      this.eventStream.write(JSON.stringify(initFrame) + "\n");
    }

    this.updateMetaField({ status: "recording" });
  }

  appendTickEvents(gameTime: GameTime, events: SimulationEvent[]): void {
    if (!this.eventStream || !this.worldDir || !this.currentTimelineId) return;

    const frame: TimelineTickFrame = {
      type: "tick",
      gameTime,
      events: events.map((e) => ({
        ...e,
        data: typeof e.data === "string" ? JSON.parse(e.data) : e.data,
        tags: typeof e.tags === "string" ? JSON.parse(e.tags as any) : e.tags,
      })),
    };

    this.eventStream.write(JSON.stringify(frame) + "\n");

    this.tickCount++;
    this.updateMetaField({
      lastGameTime: gameTime,
      tickCount: this.tickCount,
      updatedAt: new Date().toISOString(),
    });
  }

  stopRecording(): void {
    if (this.eventStream) {
      this.eventStream.end();
      this.eventStream = null;
    }
    this.updateMetaField({ status: "stopped" });
  }

  listTimelines(worldDir: string): TimelineMeta[] {
    const timelinesDir = path.join(worldDir, TIMELINES_DIR_NAME);
    if (!fs.existsSync(timelinesDir)) return [];

    return fs.readdirSync(timelinesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        try {
          return this.readMeta(worldDir, entry.name);
        } catch {
          return null;
        }
      })
      .filter((m): m is TimelineMeta => m !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  listAllTimelinesGrouped(): {
    worldId: string;
    worldName: string;
    source: string;
    isCurrent: boolean;
    timelines: TimelineMeta[];
  }[] {
    const worlds = listAllWorlds();
    const currentWorldId = this.worldDir ? path.basename(this.worldDir) : null;

    return worlds.map((world) => ({
      worldId: world.id,
      worldName: world.worldName,
      source: world.source,
      isCurrent: world.id === currentWorldId,
      timelines: this.listTimelines(world.dir),
    }));
  }

  deleteTimeline(worldDir: string, timelineId: string): void {
    const dir = this.getTimelineDir(worldDir, timelineId);
    if (!fs.existsSync(dir)) return;

    if (this.currentTimelineId === timelineId && this.worldDir === worldDir) {
      this.stopRecording();
      this.currentTimelineId = null;
    }

    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ─── 分叉 ────────────────────────────────────────────────────────────────
  //
  // 从某条时间线的某个快照分出一条新时间线。
  //
  // 三样东西必须一起处理，缺一不可：
  //
  //   新时间线/
  //   ├── state.db     ← 从快照复制（角色状态、记忆、关系、事件）
  //   ├── events.jsonl ← 从源时间线截断到分叉点（保留历史，可回放）
  //   └── meta.json    ← 记录 forkedFrom
  //
  // 只复制 DB 不截断事件流 →「状态是分叉后的，事件是分叉前的」，
  // 回放时不一致 —— 这是这个阶段最容易踩的坑。

  /**
   * 截断事件流到指定时刻。
   *
   * 关键：**按事件自身的时间戳截断，不按帧标签截断**。
   *
   * 帧标签（frame.gameTime）是「这批事件跑完之后世界的时间」，
   * 而事件自己的 gameTick 是「事件发生的时间」。批量跑一天时，
   * 一帧里会装着几十个不同 tick 的事件，标签只等于最后一个 tick。
   * 按标签截断会漏掉或错带事件。
   *
   * @returns 保留的行数（帧数）
   */
  truncateEventsToTick(
    worldDir: string,
    timelineId: string,
    day: number,
    tick: number,
  ): number {
    const eventsPath = this.getTimelineEventsPath(worldDir, timelineId);
    if (!fs.existsSync(eventsPath)) return 0;

    const content = fs.readFileSync(eventsPath, "utf-8").trim();
    if (!content) return 0;

    const lines = content.split("\n");
    const kept: string[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;

      let frame: TimelineFrame;
      try {
        frame = JSON.parse(line) as TimelineFrame;
      } catch {
        // 解析不了的行直接丢 —— 宁可少一行也不要留半个坏帧
        continue;
      }

      if (frame.type === "init") {
        kept.push(line);
        continue;
      }

      // 一帧里可能混着多个 tick 的事件（批量模拟时）。
      // 只保留事件时间戳 <= 分叉点的那部分。
      const all = frame.events ?? [];
      const events = all.filter((e: any) => {
        const d = Number(e?.gameDay);
        const t = Number(e?.gameTick);
        if (!Number.isFinite(d) || !Number.isFinite(t)) return false;
        return d < day || (d === day && t <= tick);
      });

      if (events.length === 0) continue;

      // 整帧都在范围内 → 原样保留（帧标签是「这批跑完之后的时间」，
      // 改掉它会让回放时的时间轴错位）。
      // 被截了一刀 → 标签改成这帧里剩下的最大事件 tick，
      // 否则标签会指向一个已经不存在的时刻。
      if (events.length === all.length) {
        kept.push(line);
        continue;
      }

      let maxDay = day;
      let maxTick = tick;
      for (const e of events) {
        const d = Number(e.gameDay);
        const t = Number(e.gameTick);
        if (d > maxDay || (d === maxDay && t > maxTick)) {
          maxDay = d;
          maxTick = t;
        }
      }

      kept.push(
        JSON.stringify({
          type: "tick",
          gameTime: { day: maxDay, tick: maxTick },
          events,
        }),
      );
    }

    fs.writeFileSync(eventsPath, kept.join("\n") + (kept.length ? "\n" : ""), "utf-8");
    return kept.length;
  }

  /**
   * 从快照分叉出一条新时间线。
   *
   * @param worldDir 世界目录
   * @param sourceTimelineId 源时间线 id
   * @param snapshotId 快照 id（必须是源时间线里的）
   * @param label 新时间线的标签（如「如果当时没去问陆先生」）
   * @returns 新时间线 id
   */
  forkFromSnapshot(
    worldDir: string,
    sourceTimelineId: string,
    snapshotId: string,
    label?: string,
  ): string {
    const sourceDir = this.getTimelineDir(worldDir, sourceTimelineId);
    if (!fs.existsSync(sourceDir)) {
      throw new Error(`Timeline not found: ${sourceTimelineId}`);
    }

    const snapshot = getTimelineSnapshot(
      { dir: sourceDir, dbPath: this.getTimelineDbPath(worldDir, sourceTimelineId) },
      snapshotId,
    );
    if (!snapshot) {
      throw new Error(`Snapshot not found: ${snapshotId}`);
    }
    if (!fs.existsSync(snapshot.filePath)) {
      throw new Error(`Snapshot file not found: ${snapshot.filePath}`);
    }

    // 先截断源时间线的事件流 —— 复制快照 DB 时会连带把 events 表复制过去，
    // 但 events.jsonl 是独立文件，要单独处理。
    // 注意：这里改的是**新**时间线的副本，不是源时间线。
    const newId = this.generateForkId();
    const newDir = this.getTimelineDir(worldDir, newId);
    fs.mkdirSync(newDir, { recursive: true });

    // 1) state.db ← 从快照复制
    const newDbPath = this.getTimelineDbPath(worldDir, newId);
    fs.copyFileSync(snapshot.filePath, newDbPath);

    // 2) events.jsonl ← 从源时间线复制后截断
    const sourceEvents = this.getTimelineEventsPath(worldDir, sourceTimelineId);
    const newEvents = this.getTimelineEventsPath(worldDir, newId);
    if (fs.existsSync(sourceEvents)) {
      fs.copyFileSync(sourceEvents, newEvents);
    }

    // 3) meta.json
    const worldId = path.basename(worldDir);
    const now = new Date().toISOString();
    const meta: TimelineMeta = {
      id: newId,
      worldId,
      createdAt: now,
      updatedAt: now,
      lastGameTime: { day: snapshot.gameDay, tick: snapshot.gameTick },
      tickCount: 0,
      status: "stopped",
      forkedFrom: {
        timelineId: sourceTimelineId,
        snapshotId,
        tick: snapshot.gameTick,
        day: snapshot.gameDay,
      },
      label,
    };
    fs.writeFileSync(path.join(newDir, "meta.json"), JSON.stringify(meta, null, 2));

    // 4) 截断新时间线的事件流到分叉点
    this.truncateEventsToTick(worldDir, newId, snapshot.gameDay, snapshot.gameTick);

    // 截断后 tick 数要跟分叉点对齐
    const frames = this.readTimelineEvents(worldDir, newId);
    const tickFrames = frames.filter((f) => f.type === "tick");
    meta.tickCount = tickFrames.length;
    meta.lastGameTime = { day: snapshot.gameDay, tick: snapshot.gameTick };
    fs.writeFileSync(path.join(newDir, "meta.json"), JSON.stringify(meta, null, 2));

    return newId;
  }

  /**
   * 把时间线恢复到某个快照。
   *
   * **DB 和事件流必须一起回退** —— 只还原 state.db 的话，
   * 磁盘上的状态是快照时的，events.jsonl 里却还记着快照之后发生的事，
   * 回放时会重演那些已经「没发生过」的事件。
   * 这是「状态和事件不一致」的另一个入口，跟分叉时截断事件流是同一个道理。
   */
  restoreToSnapshot(
    worldDir: string,
    timelineId: string,
    snapshotId: string,
  ): { day: number; tick: number } {
    const dir = this.getTimelineDir(worldDir, timelineId);
    const dbPath = this.getTimelineDbPath(worldDir, timelineId);
    if (!fs.existsSync(dbPath)) {
      throw new Error(`Timeline not found: ${timelineId}`);
    }

    const snapshot = getTimelineSnapshot({ dir, dbPath }, snapshotId);
    if (!snapshot) {
      throw new Error(`Snapshot not found: ${snapshotId}`);
    }

    // 1) 状态还原
    restoreTimelineSnapshot({ dir, dbPath }, snapshotId);

    // 2) 事件流回退到快照时刻
    this.truncateEventsToTick(worldDir, timelineId, snapshot.gameDay, snapshot.gameTick);

    // 3) meta 对齐
    const metaPath = path.join(dir, "meta.json");
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as TimelineMeta;
      const frames = this.readTimelineEvents(worldDir, timelineId);
      meta.tickCount = frames.filter((f) => f.type === "tick").length;
      meta.lastGameTime = { day: snapshot.gameDay, tick: snapshot.gameTick };
      meta.updatedAt = new Date().toISOString();
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    }

    return { day: snapshot.gameDay, tick: snapshot.gameTick };
  }

  /** 分叉用的 id —— 加前缀区分于普通时间线，便于一眼看出是分叉出来的 */
  private generateForkId(): string {
    const now = new Date();
    const pad = (n: number, len = 2) => String(n).padStart(len, "0");
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return `tl-fork-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
  }

  getTimelineDir(worldDir: string, timelineId: string): string {
    return path.join(worldDir, TIMELINES_DIR_NAME, timelineId);
  }

  getTimelineDbPath(worldDir: string, timelineId: string): string {
    return path.join(this.getTimelineDir(worldDir, timelineId), "state.db");
  }

  getTimelineEventsPath(worldDir: string, timelineId: string): string {
    return path.join(this.getTimelineDir(worldDir, timelineId), "events.jsonl");
  }

  getCurrentTimelineId(): string | null {
    return this.currentTimelineId;
  }

  getCurrentWorldDir(): string | null {
    return this.worldDir;
  }

  getTickCount(): number {
    return this.tickCount;
  }

  readTimelineEvents(worldDir: string, timelineId: string): TimelineFrame[] {
    const eventsPath = this.getTimelineEventsPath(worldDir, timelineId);
    if (!fs.existsSync(eventsPath)) return [];

    const content = fs.readFileSync(eventsPath, "utf-8").trim();
    if (!content) return [];

    return content.split("\n").map((line) => JSON.parse(line) as TimelineFrame);
  }

  private getCurrentEventsPath(): string | null {
    if (!this.worldDir || !this.currentTimelineId) return null;
    return this.getTimelineEventsPath(this.worldDir, this.currentTimelineId);
  }

  private readMeta(worldDir: string, timelineId: string): TimelineMeta {
    const metaPath = path.join(
      this.getTimelineDir(worldDir, timelineId),
      "meta.json",
    );
    return JSON.parse(fs.readFileSync(metaPath, "utf-8")) as TimelineMeta;
  }

  private updateMetaField(patch: Partial<TimelineMeta>): void {
    if (!this.worldDir || !this.currentTimelineId) return;

    const dir = this.getTimelineDir(this.worldDir, this.currentTimelineId);
    const metaPath = path.join(dir, "meta.json");
    if (!fs.existsSync(metaPath)) return;

    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as TimelineMeta;
      Object.assign(meta, patch);
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    } catch {
      // Non-critical; best-effort update
    }
  }
}
