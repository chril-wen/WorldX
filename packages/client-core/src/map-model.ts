import { DEFAULT_CENTER_LOCATION_ID } from "@worldx/core";
import {
  DEFAULT_TILE_SIZE,
  parseTmj,
  toInteractiveObjects,
  toLocationRects,
} from "@worldx/core";
import type { MainAreaPointInfo } from "./types.js";
import type { InteractiveObject, LocationRect, MainAreaPointNode } from "./types.js";

export type { InteractiveObject, LocationRect, MainAreaPointNode };

interface WalkablePlacementPreference {
  cardinalClearance: number;
  neighborhoodScore: number;
}

const MAIN_AREA_OCCUPANCY_RADIUS_PX = 24;

export class MapManager {
  collisionGrid: number[][] = [];
  gridWidth = 0;
  gridHeight = 0;
  tileSize = DEFAULT_TILE_SIZE;

  locations: Map<string, LocationRect> = new Map();
  interactiveObjects: Map<string, InteractiveObject> = new Map();
  mainAreaPoints: Map<string, MainAreaPointNode> = new Map();
  private walkableComponentCache: Map<string, Set<string>> = new Map();

  /**
   * 中心区域的 id —— 世界的公共枢纽。
   *
   * 角色在里面用 `mainAreaPointId` 点位寻址。
   *
   * 默认是 `"main_area"` —— 旧世界都叫这个。真正的值要等
   * `/world/info` 回来才知道（见 `setCenterLocationId`）。
   */
  private centerLocationId: string = DEFAULT_CENTER_LOCATION_ID;

  getCenterLocationId(): string {
    return this.centerLocationId;
  }

  /**
   * 设置中心区域的 id —— 拿到 `/world/info` 之后调用。
   *
   * ## 为什么需要一个「修正」步骤
   *
   * `loadFromTiledJSON()` 是**同步**的，在 Phaser 的 `create()` 里跑；
   * 而中心区域 id 要等**异步**的 `/world/info` 才回来。
   *
   * 所以合成兜底先用一个占位 id 建好，拿到真 id 之后
   * 这里把已经建好的 location 改名 —— 否则地图上那个合成区域
   * 会永远挂着错的 id，寻路和区域判定会对不上。
   */
  setCenterLocationId(id: string): void {
    if (typeof id !== "string" || id.trim().length === 0) return;
    const next = id.trim();
    if (next === this.centerLocationId) return;

    // 之前用占位 id 合成的区域 —— 改成真 id。
    const synthetic = this.locations.get(this.centerLocationId);
    if (synthetic?.synthetic) {
      this.locations.delete(this.centerLocationId);
      const renamed: LocationRect = { ...synthetic, id: next };
      this.locations.set(next, renamed);
    }
    this.centerLocationId = next;
  }

  loadFromTiledJSON(json: any): void {
    // 解析交给 tmj-parser —— 全仓唯一的一份实现。
    //
    // **行为跟搬进来之前逐字等价**：区域没有 id 就跳过（不退回用 name），
    // 物件没有 objectId 就跳过，collision 里非 0 视为阻挡。
    const parsed = parseTmj(json);

    this.tileSize = parsed.tileSize;
    this.gridWidth = parsed.width;
    this.gridHeight = parsed.height;
    this.locations.clear();
    this.interactiveObjects.clear();
    this.mainAreaPoints.clear();
    this.walkableComponentCache.clear();

    // 碰撞网格只在 TMJ 真的有 collision 层时替换 ——
    // 跟搬进来之前一样（没有 collision 层时保留上一次的网格）。
    if (parsed.collisionGrid) {
      this.collisionGrid = parsed.collisionGrid;
    }

    for (const rect of toLocationRects(parsed.regions)) {
      this.locations.set(rect.id, rect);
    }

    for (const obj of toInteractiveObjects(parsed.interactiveObjects)) {
      this.interactiveObjects.set(obj.objectId, obj);
    }

    if (this.locations.size === 0) {
      // 合成兜底 —— 用当前的中心 id 占位。
      // 拿到 /world/info 之后 setCenterLocationId() 会把它改成真 id。
      this.locations.set(this.centerLocationId, {
        id: this.centerLocationId,
        name: "Main Area",
        x: 0,
        y: 0,
        width: this.gridWidth * this.tileSize,
        height: this.gridHeight * this.tileSize,
        synthetic: true,
      });
    }

    console.log(
      `[MapManager] Grid: ${this.gridWidth}x${this.gridHeight}, ` +
      `Locations: ${this.locations.size}, Objects: ${this.interactiveObjects.size}`
    );
  }

  pixelToGrid(px: number, py: number): { gx: number; gy: number } {
    return {
      gx: Math.floor(px / this.tileSize),
      gy: Math.floor(py / this.tileSize),
    };
  }

  gridToPixel(gx: number, gy: number): { x: number; y: number } {
    return {
      x: gx * this.tileSize + this.tileSize / 2,
      y: gy * this.tileSize + this.tileSize / 2,
    };
  }

  isWalkable(gx: number, gy: number): boolean {
    if (gx < 0 || gy < 0 || gx >= this.gridWidth || gy >= this.gridHeight) return false;
    return this.collisionGrid[gy]?.[gx] === 0;
  }

  hasWalkableLine(
    from: { gx: number; gy: number },
    to: { gx: number; gy: number },
  ): boolean {
    if (!this.isWalkable(from.gx, from.gy) || !this.isWalkable(to.gx, to.gy)) {
      return false;
    }

    const start = this.gridToPixel(from.gx, from.gy);
    const end = this.gridToPixel(to.gx, to.gy);
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    const stepSize = Math.max(4, this.tileSize / 3);
    const steps = Math.max(1, Math.ceil(distance / stepSize));

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const sampleX = start.x + (end.x - start.x) * t;
      const sampleY = start.y + (end.y - start.y) * t;
      const sample = this.pixelToGrid(sampleX, sampleY);
      if (!this.isWalkable(sample.gx, sample.gy)) {
        return false;
      }
    }

    return true;
  }

  getRandomWalkablePointInLocation(
    locationId: string,
    options: { preferInset?: boolean } = {},
  ): { x: number; y: number } | null {
    const loc = this.locations.get(locationId);
    if (!loc) return this.getRandomWalkablePoint();

    if (!this.isPinnedLocation(locationId)) {
      return this.getRandomWalkablePoint();
    }

    if (options.preferInset) {
      const insetBounds = this.getInsetBounds(loc);
      const insetPoint = this.getRandomWalkablePointInBounds(
        insetBounds,
        this.getPreferredComponentForBounds(`${locationId}:inset`, insetBounds),
      );
      if (insetPoint) return insetPoint;
    }

    return this.getRandomWalkablePointInBounds(
      loc,
      this.getPreferredComponentForBounds(`${locationId}:full`, loc),
    );
  }

  setMainAreaPoints(points: MainAreaPointInfo[] | undefined): void {
    this.mainAreaPoints.clear();
    for (const point of points || []) {
      if (!point?.id) continue;
      this.mainAreaPoints.set(point.id, {
        ...point,
        adjacentPointIds: Array.isArray(point.adjacentPointIds) ? point.adjacentPointIds : [],
      });
    }
  }

  getMainAreaPoint(pointId: string | null | undefined): MainAreaPointNode | null {
    if (!pointId) return null;
    return this.mainAreaPoints.get(pointId) ?? null;
  }

  getMainAreaPoints(): MainAreaPointNode[] {
    return Array.from(this.mainAreaPoints.values());
  }

  getMainAreaPlacement(
    pointId: string,
    characterId: string,
    options: {
      occupantIds?: string[];
    } = {},
  ): { x: number; y: number } | null {
    const point = this.getMainAreaPoint(pointId);
    if (!point) return null;

    const orderedIds = this.getOrderedOccupantIds(characterId, options.occupantIds);
    const assignedIndex = Math.max(0, orderedIds.indexOf(characterId));
    const offsets = this.getMainAreaOccupancyOffsets(orderedIds.length);
    const preferredOffsets = [
      offsets[assignedIndex % offsets.length],
      ...offsets.filter((_, index) => index !== assignedIndex % offsets.length),
    ];

    for (const [ox, oy] of preferredOffsets) {
      const candidate = {
        x: point.x + ox * MAIN_AREA_OCCUPANCY_RADIUS_PX,
        y: point.y + oy * MAIN_AREA_OCCUPANCY_RADIUS_PX,
      };
      const grid = this.pixelToGrid(candidate.x, candidate.y);
      if (this.isWalkable(grid.gx, grid.gy)) {
        return candidate;
      }
    }

    const pointGrid = this.pixelToGrid(point.x, point.y);
    return this.isWalkable(pointGrid.gx, pointGrid.gy) ? { x: point.x, y: point.y } : null;
  }

  getMainAreaDialoguePairPlacements(
    pointId: string,
    initiatorId: string,
    responderId: string,
    desiredDistance: number,
    approachFrom: { x: number; y: number },
  ): { initiator: { x: number; y: number }; responder: { x: number; y: number } } | null {
    const point = this.getMainAreaPoint(pointId);
    if (!point) return null;

    const halfDistance = Math.max(MAIN_AREA_OCCUPANCY_RADIUS_PX, desiredDistance / 2);
    const dominantAxis = this.getDominantDialogueAxis(approachFrom);
    const horizontalAxis = dominantAxis.x !== 0 ? dominantAxis : { x: 1, y: 0 };
    const verticalAxis = dominantAxis.y !== 0 ? dominantAxis : { x: 0, y: 1 };
    const axisCandidates = [horizontalAxis, verticalAxis];
    const validPairs: Array<{
      initiator: { x: number; y: number };
      responder: { x: number; y: number };
      axisIndex: number;
      minCardinalClearance: number;
      neighborhoodScore: number;
    }> = [];

    for (const [axisIndex, axis] of axisCandidates.entries()) {
      const initiator = {
        x: point.x + axis.x * halfDistance,
        y: point.y + axis.y * halfDistance,
      };
      const responder = {
        x: point.x - axis.x * halfDistance,
        y: point.y - axis.y * halfDistance,
      };
      if (this.isPixelWalkable(initiator.x, initiator.y) && this.isPixelWalkable(responder.x, responder.y)) {
        const initiatorGrid = this.pixelToGrid(initiator.x, initiator.y);
        const responderGrid = this.pixelToGrid(responder.x, responder.y);
        const initiatorPreference = this.getWalkablePlacementPreference(initiatorGrid.gx, initiatorGrid.gy);
        const responderPreference = this.getWalkablePlacementPreference(responderGrid.gx, responderGrid.gy);
        validPairs.push({
          initiator,
          responder,
          axisIndex,
          minCardinalClearance: Math.min(
            initiatorPreference.cardinalClearance,
            responderPreference.cardinalClearance,
          ),
          neighborhoodScore:
            initiatorPreference.neighborhoodScore + responderPreference.neighborhoodScore,
        });
      }
    }

    validPairs.sort((a, b) => {
      if (b.minCardinalClearance !== a.minCardinalClearance) {
        return b.minCardinalClearance - a.minCardinalClearance;
      }
      if (b.neighborhoodScore !== a.neighborhoodScore) {
        return b.neighborhoodScore - a.neighborhoodScore;
      }
      return a.axisIndex - b.axisIndex;
    });

    const bestPair = validPairs[0];
    if (bestPair) {
      return { initiator: bestPair.initiator, responder: bestPair.responder };
    }

    const initiatorFallback = this.getMainAreaPlacement(pointId, initiatorId, {
      occupantIds: [initiatorId, responderId],
    });
    const responderFallback = this.getMainAreaPlacement(pointId, responderId, {
      occupantIds: [initiatorId, responderId],
    });
    if (
      initiatorFallback &&
      responderFallback &&
      this.distanceBetween(initiatorFallback, responderFallback) >= desiredDistance * 0.85
    ) {
      return { initiator: initiatorFallback, responder: responderFallback };
    }

    return null;
  }

  getWalkableCandidatesNear(
    centerX: number,
    centerY: number,
    maxDistanceTiles = 4,
    locationId?: string,
  ): Array<{ gx: number; gy: number; x: number; y: number; distance: number }> {
    const radiusPx = Math.max(this.tileSize, maxDistanceTiles * this.tileSize);
    const minGX = Math.max(0, Math.floor((centerX - radiusPx) / this.tileSize));
    const minGY = Math.max(0, Math.floor((centerY - radiusPx) / this.tileSize));
    const maxGX = Math.min(this.gridWidth - 1, Math.ceil((centerX + radiusPx) / this.tileSize));
    const maxGY = Math.min(this.gridHeight - 1, Math.ceil((centerY + radiusPx) / this.tileSize));
    const constrainedBounds =
      locationId && this.isPinnedLocation(locationId)
        ? this.getInsetBounds(this.locations.get(locationId)!)
        : null;
    const preferredComponent =
      locationId && this.isPinnedLocation(locationId) && constrainedBounds
        ? this.getPreferredComponentForBounds(`${locationId}:inset`, constrainedBounds)
        : null;
    const walkable: Array<{ gx: number; gy: number; x: number; y: number; distance: number }> = [];

    for (let gy = minGY; gy <= maxGY; gy++) {
      for (let gx = minGX; gx <= maxGX; gx++) {
        if (!this.isWalkable(gx, gy)) continue;
        if (preferredComponent && !preferredComponent.has(this.getCellKey(gx, gy))) continue;

        const pixel = this.gridToPixel(gx, gy);
        const distance = Math.hypot(centerX - pixel.x, centerY - pixel.y);
        if (distance > radiusPx) continue;
        if (constrainedBounds && !this.isPointInsideBounds(pixel.x, pixel.y, constrainedBounds)) {
          continue;
        }

        walkable.push({ gx, gy, x: pixel.x, y: pixel.y, distance });
      }
    }

    walkable.sort((a, b) => a.distance - b.distance);
    return walkable;
  }

  getRandomWalkablePointNear(
    centerX: number,
    centerY: number,
    maxDistanceTiles = 4,
    locationId?: string,
  ): { x: number; y: number } | null {
    const walkable = this.getWalkableCandidatesNear(
      centerX,
      centerY,
      maxDistanceTiles,
      locationId,
    );

    if (walkable.length === 0) {
      if (locationId) {
        return this.getRandomWalkablePointInLocation(locationId, {
          preferInset: this.isPinnedLocation(locationId),
        });
      }
      return this.getRandomWalkablePoint();
    }

    walkable.sort((a, b) => a.distance - b.distance);
    const preferredPool = walkable.slice(0, Math.max(1, Math.ceil(walkable.length * 0.65)));
    const safetyPreferredPool = this.filterPreferredWalkableCandidates(preferredPool);
    const pick = safetyPreferredPool[Math.floor(Math.random() * safetyPreferredPool.length)];
    return { x: pick.x, y: pick.y };
  }

  isPinnedLocation(locationId: string | null | undefined): boolean {
    if (!locationId) return false;
    const loc = this.locations.get(locationId);
    if (!loc) return false;
    return !(loc.synthetic && loc.id === this.centerLocationId);
  }

  getVisibleLocations(): LocationRect[] {
    return Array.from(this.locations.values()).filter(
      (loc) => !(loc.synthetic && loc.id === this.centerLocationId),
    );
  }

  getInteractiveObjects(): InteractiveObject[] {
    return Array.from(this.interactiveObjects.values());
  }

  getLocationAtPixel(px: number, py: number): string | null {
    for (const [id, loc] of this.locations) {
      if (px >= loc.x && px < loc.x + loc.width && py >= loc.y && py < loc.y + loc.height) {
        return id;
      }
    }
    return null;
  }

  getObjectPosition(objectId: string): { x: number; y: number } | null {
    const obj = this.interactiveObjects.get(objectId);
    if (!obj) return null;
    return { x: obj.x, y: obj.y };
  }

  getObjectInteractionPosition(objectId: string): { x: number; y: number } | null {
    const obj = this.interactiveObjects.get(objectId);
    if (!obj) return null;

    const centerX = obj.x + obj.width / 2;
    const standY = obj.y + obj.height + this.tileSize;
    return { x: centerX, y: standY };
  }

  getAllLocationIds(): string[] {
    return Array.from(this.locations.keys());
  }

  getLocationName(locationId: string): string {
    return this.locations.get(locationId)?.name || locationId;
  }

  private getRandomWalkablePoint(): { x: number; y: number } | null {
    return this.getRandomWalkablePointInBounds({
      x: 0,
      y: 0,
      width: this.gridWidth * this.tileSize,
      height: this.gridHeight * this.tileSize,
    });
  }

  private getRandomWalkablePointInBounds(
    bounds: Pick<LocationRect, "x" | "y" | "width" | "height">,
    preferredComponent?: Set<string> | null,
  ): { x: number; y: number } | null {
    const minGX = Math.max(0, Math.floor(bounds.x / this.tileSize));
    const minGY = Math.max(0, Math.floor(bounds.y / this.tileSize));
    const maxGX = Math.min(this.gridWidth - 1, Math.ceil((bounds.x + bounds.width) / this.tileSize) - 1);
    const maxGY = Math.min(this.gridHeight - 1, Math.ceil((bounds.y + bounds.height) / this.tileSize) - 1);
    const walkable: { gx: number; gy: number }[] = [];

    for (let gy = minGY; gy <= maxGY; gy++) {
      for (let gx = minGX; gx <= maxGX; gx++) {
        if (!this.isWalkable(gx, gy)) continue;
        if (preferredComponent && !preferredComponent.has(this.getCellKey(gx, gy))) continue;
        const pixel = this.gridToPixel(gx, gy);
        if (this.isPointInsideBounds(pixel.x, pixel.y, bounds)) {
          walkable.push({ gx, gy });
        }
      }
    }

    if (walkable.length === 0) return null;
    const preferredPool = this.filterPreferredWalkableCandidates(walkable);
    const pick = preferredPool[Math.floor(Math.random() * preferredPool.length)];
    return this.gridToPixel(pick.gx, pick.gy);
  }

  private getPreferredComponentForBounds(
    cacheKey: string,
    bounds: Pick<LocationRect, "x" | "y" | "width" | "height">,
  ): Set<string> | null {
    const cached = this.walkableComponentCache.get(cacheKey);
    if (cached) return cached;

    const minGX = Math.max(0, Math.floor(bounds.x / this.tileSize));
    const minGY = Math.max(0, Math.floor(bounds.y / this.tileSize));
    const maxGX = Math.min(this.gridWidth - 1, Math.ceil((bounds.x + bounds.width) / this.tileSize) - 1);
    const maxGY = Math.min(this.gridHeight - 1, Math.ceil((bounds.y + bounds.height) / this.tileSize) - 1);
    const walkable = new Set<string>();

    for (let gy = minGY; gy <= maxGY; gy++) {
      for (let gx = minGX; gx <= maxGX; gx++) {
        if (!this.isWalkable(gx, gy)) continue;
        const pixel = this.gridToPixel(gx, gy);
        if (!this.isPointInsideBounds(pixel.x, pixel.y, bounds)) continue;
        walkable.add(this.getCellKey(gx, gy));
      }
    }

    if (walkable.size === 0) {
      return null;
    }

    const visited = new Set<string>();
    let largest: Set<string> | null = null;

    for (const cellKey of walkable) {
      if (visited.has(cellKey)) continue;
      const component = new Set<string>();
      const queue = [cellKey];
      visited.add(cellKey);

      while (queue.length > 0) {
        const currentKey = queue.shift()!;
        component.add(currentKey);
        const [gx, gy] = this.parseCellKey(currentKey);
        const neighbors = [
          [gx + 1, gy],
          [gx - 1, gy],
          [gx, gy + 1],
          [gx, gy - 1],
        ];

        for (const [nx, ny] of neighbors) {
          const neighborKey = this.getCellKey(nx, ny);
          if (!walkable.has(neighborKey) || visited.has(neighborKey)) continue;
          visited.add(neighborKey);
          queue.push(neighborKey);
        }
      }

      if (!largest || component.size > largest.size) {
        largest = component;
      }
    }

    if (largest) {
      this.walkableComponentCache.set(cacheKey, largest);
    }

    return largest;
  }

  private getCellKey(gx: number, gy: number): string {
    return `${gx},${gy}`;
  }

  private getOrderedOccupantIds(characterId: string, occupantIds?: string[]): string[] {
    const ordered = Array.from(new Set([...(occupantIds || []), characterId])).sort();
    return ordered.length > 0 ? ordered : [characterId];
  }

  private getWalkablePlacementPreference(gx: number, gy: number): WalkablePlacementPreference {
    const cardinalNeighbors: Array<[number, number]> = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    const diagonalNeighbors: Array<[number, number]> = [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ];
    let cardinalClearance = 0;
    let neighborhoodScore = 0;

    for (const [dx, dy] of cardinalNeighbors) {
      if (!this.isWalkable(gx + dx, gy + dy)) continue;
      cardinalClearance += 1;
      neighborhoodScore += 2;
    }
    for (const [dx, dy] of diagonalNeighbors) {
      if (!this.isWalkable(gx + dx, gy + dy)) continue;
      neighborhoodScore += 1;
    }

    return { cardinalClearance, neighborhoodScore };
  }

  private filterPreferredWalkableCandidates<T extends { gx: number; gy: number }>(candidates: T[]): T[] {
    if (candidates.length <= 1) return candidates;

    const scored = candidates.map((candidate) => ({
      candidate,
      preference: this.getWalkablePlacementPreference(candidate.gx, candidate.gy),
    }));
    scored.sort((a, b) => {
      if (b.preference.cardinalClearance !== a.preference.cardinalClearance) {
        return b.preference.cardinalClearance - a.preference.cardinalClearance;
      }
      return b.preference.neighborhoodScore - a.preference.neighborhoodScore;
    });

    const best = scored[0]?.preference;
    if (!best) return candidates;

    const relaxedNeighborhoodFloor = Math.max(0, best.neighborhoodScore - 1);
    return scored
      .filter(
        ({ preference }) =>
          preference.cardinalClearance === best.cardinalClearance &&
          preference.neighborhoodScore >= relaxedNeighborhoodFloor,
      )
      .map(({ candidate }) => candidate);
  }

  private getMainAreaOccupancyOffsets(count: number): Array<[number, number]> {
    if (count <= 1) {
      return [[0, 0]];
    }
    return [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
      [-0.78, -0.78],
      [0.78, -0.78],
      [-0.78, 0.78],
      [0.78, 0.78],
    ];
  }

  private getDominantDialogueAxis(vector: { x: number; y: number }): { x: number; y: number } {
    if (Math.abs(vector.x) >= Math.abs(vector.y)) {
      return { x: vector.x >= 0 ? 1 : -1, y: 0 };
    }
    return { x: 0, y: vector.y >= 0 ? 1 : -1 };
  }

  private distanceBetween(
    a: { x: number; y: number },
    b: { x: number; y: number },
  ): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  private isPixelWalkable(x: number, y: number): boolean {
    const grid = this.pixelToGrid(x, y);
    return this.isWalkable(grid.gx, grid.gy);
  }

  private parseCellKey(value: string): [number, number] {
    const [gx, gy] = value.split(",").map(Number);
    return [gx, gy];
  }

  private getInsetBounds(location: LocationRect): Pick<LocationRect, "x" | "y" | "width" | "height"> {
    if (!this.isPinnedLocation(location.id)) {
      return location;
    }

    const maxInsetX = Math.max(0, location.width / 2 - this.tileSize);
    const maxInsetY = Math.max(0, location.height / 2 - this.tileSize);
    const insetX = Math.min(maxInsetX, Math.max(this.tileSize, Math.round(location.width * 0.16)));
    const insetY = Math.min(maxInsetY, Math.max(this.tileSize, Math.round(location.height * 0.16)));

    return {
      x: location.x + Math.max(0, insetX),
      y: location.y + Math.max(0, insetY),
      width: Math.max(this.tileSize, location.width - Math.max(0, insetX) * 2),
      height: Math.max(this.tileSize, location.height - Math.max(0, insetY) * 2),
    };
  }

  private isPointInsideBounds(
    px: number,
    py: number,
    bounds: Pick<LocationRect, "x" | "y" | "width" | "height">,
  ): boolean {
    return (
      px >= bounds.x &&
      px <= bounds.x + bounds.width &&
      py >= bounds.y &&
      py <= bounds.y + bounds.height
    );
  }
}

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}
