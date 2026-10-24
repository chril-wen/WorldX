/**
 * 内存版事件存储 —— 只用于 core 的单测。
 */

import type {
  EventQueryFilter,
  EventStorage,
  GameTime,
  SimulationEvent,
} from "../contracts/index.js";

export class InMemoryEventStorage implements EventStorage {
  private rows: SimulationEvent[] = [];

  appendEvent(event: SimulationEvent): void {
    this.rows.push({ ...event });
  }

  appendEvents(events: SimulationEvent[]): void {
    for (const e of events) this.appendEvent(e);
  }

  queryEvents(filter: EventQueryFilter = {}): SimulationEvent[] {
    let results = this.rows.filter((e) => {
      if (filter.fromDay !== undefined && e.gameDay < filter.fromDay) return false;
      if (filter.toDay !== undefined && e.gameDay > filter.toDay) return false;
      if (filter.fromTick !== undefined && e.gameTick < filter.fromTick) return false;
      if (filter.toTick !== undefined && e.gameTick > filter.toTick) return false;
      if (filter.type !== undefined && e.type !== filter.type) return false;
      if (filter.actorId !== undefined && e.actorId !== filter.actorId) return false;
      if (filter.location !== undefined && e.location !== filter.location) return false;
      if (
        filter.minDramScore !== undefined &&
        (e.dramScore ?? 0) < filter.minDramScore
      ) {
        return false;
      }
      return true;
    });

    results = [...results].sort(
      (a, b) => a.gameDay - b.gameDay || a.gameTick - b.gameTick,
    );

    if (filter.offset !== undefined) results = results.slice(filter.offset);
    if (filter.limit !== undefined) results = results.slice(0, filter.limit);

    return results.map((e) => ({ ...e }));
  }

  getEventsByTimeRange(from: GameTime, to: GameTime): SimulationEvent[] {
    return this.rows
      .filter(
        (e) =>
          e.gameDay > from.day ||
          (e.gameDay === from.day && e.gameTick >= from.tick),
      )
      .filter(
        (e) =>
          e.gameDay < to.day || (e.gameDay === to.day && e.gameTick <= to.tick),
      )
      .map((e) => ({ ...e }));
  }

  getEventsByIds(ids: string[]): SimulationEvent[] {
    return this.rows.filter((e) => ids.includes(e.id)).map((e) => ({ ...e }));
  }

  getLatestEvents(count: number): SimulationEvent[] {
    return [...this.rows]
      .sort((a, b) => b.gameDay - a.gameDay || b.gameTick - a.gameTick)
      .slice(0, count)
      .map((e) => ({ ...e }));
  }

  countEvents(filter: EventQueryFilter = {}): number {
    return this.queryEvents(filter).length;
  }
}
