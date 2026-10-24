/**
 * 事件流与内容候选的存储契约。
 *
 * 事件流是整个世界的时间线 —— 阶段 7 的快照/分叉就是靠它能精确截断。
 */

import type {
  ContentCandidate,
  GameTime,
  SimEventType,
  SimulationEvent,
} from "./index.js";

export interface EventQueryFilter {
  fromDay?: number;
  toDay?: number;
  fromTick?: number;
  toTick?: number;
  type?: SimEventType;
  actorId?: string;
  location?: string;
  minDramScore?: number;
  limit?: number;
  offset?: number;
}

export interface EventStorage {
  appendEvent(event: SimulationEvent): void;
  appendEvents(events: SimulationEvent[]): void;
  queryEvents(filter: EventQueryFilter): SimulationEvent[];
  getEventsByTimeRange(from: GameTime, to: GameTime): SimulationEvent[];
  getEventsByIds(ids: string[]): SimulationEvent[];
  getLatestEvents(count: number): SimulationEvent[];
  countEvents(filter?: EventQueryFilter): number;
}

export interface CandidateFilter {
  type?: ContentCandidate["type"];
  reviewed?: boolean;
  minDramScore?: number;
  limit?: number;
}

export interface ContentStorage {
  insertCandidate(candidate: ContentCandidate): void;
  getCandidates(filter?: CandidateFilter): ContentCandidate[];
  markReviewed(id: string): void;
  deleteCandidate(id: string): void;
}
