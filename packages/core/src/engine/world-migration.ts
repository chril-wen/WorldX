import {
  DEFAULT_CENTER_LOCATION_ID,
  WORLD_SCHEMA_VERSION,
  type LocationConfig,
  type WorldConfig,
} from "../contracts/world.js";

/**
 * world.json 的版本迁移。
 *
 * ## 为什么需要它
 *
 * 加了 `centerLocationId` 之后，**已经存在的世界**（磁盘上的 world.json）
 * 没有这个字段。迁移函数在**读取时**补上 —— 旧世界不用改磁盘文件，
 * 直接就能跑。
 *
 * ## 三条硬性要求
 *
 * 1. **幂等** —— 迁移过的再迁移一次，输出不变。
 *    （`WorldManager.addLocation()` 会把内存态写回磁盘，
 *    写回的东西必须已经是迁移过的，否则会来回震荡。）
 *
 * 2. **只补不删** —— 不丢用户数据。
 *    迁移后除新增字段外，其余**逐字段相等**。
 *
 * 3. **容忍残缺** —— 真实世界的 world.json 键位本来就不齐
 *    （`economics` / `hearsay` / `weather` 有的有、有的没有），
 *    缺 `locations`、缺 `worldName` 都不能崩。
 */

/** 已经是 v2（或更高）的配置，不再处理。 */
function isCurrentVersion(raw: Record<string, unknown>): boolean {
  const version = raw.schemaVersion;
  return typeof version === "number" && version >= WORLD_SCHEMA_VERSION;
}

/**
 * 迁移世界配置到当前 schema 版本。
 *
 * @param raw 读进来的原始 JSON（可能是任何形状）
 * @returns 迁移后的配置 —— 一定带 `schemaVersion` 和 `centerLocationId`
 */
export function migrateWorldConfig(raw: unknown): WorldConfig {
  // 非对象（null / 数组 / 字符串）—— 当成一个空世界。
  // 抛错的话，server 启动会直接挂掉；一个坏 world.json
  // 不该让整个服务起不来。
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      schemaVersion: WORLD_SCHEMA_VERSION,
      centerLocationId: DEFAULT_CENTER_LOCATION_ID,
      locations: [],
    };
  }

  const config = raw as Record<string, unknown>;

  if (isCurrentVersion(config)) {
    // 已经是当前版本 —— 只补齐「可能缺失的默认字段」，不动别的。
    return {
      ...(config as unknown as WorldConfig),
      schemaVersion: config.schemaVersion as number,
      centerLocationId: resolveCenterLocationId(config.centerLocationId),
      locations: resolveLocations(config.locations),
    };
  }

  // v1 → v2：补 schemaVersion 和 centerLocationId。
  return {
    ...(config as unknown as WorldConfig),
    schemaVersion: WORLD_SCHEMA_VERSION,
    centerLocationId: resolveCenterLocationId(config.centerLocationId),
    locations: resolveLocations(config.locations),
  };
}

/**
 * 区域列表 —— 缺失或不是数组时给空数组。
 *
 * `WorldConfig.locations` 在类型上是必填的，所以迁移函数得保证它有值。
 */
function resolveLocations(value: unknown): LocationConfig[] {
  return Array.isArray(value) ? (value as LocationConfig[]) : [];
}

/**
 * 中心区域的 id —— 缺失或不是非空字符串时用默认值。
 *
 * 写成非空字符串才算数：空串会让所有 `location === centerId` 的判断
 * 永远为 false（角色在「主区域」里却被当成在别的地方）。
 */
function resolveCenterLocationId(value: unknown): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return DEFAULT_CENTER_LOCATION_ID;
}
