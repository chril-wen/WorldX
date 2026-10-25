import type { LocationConfig } from "../contracts/index.js";

/**
 * 区域归一化 —— 世界区域列表的**唯一**实现。
 *
 * ## 这里为什么曾经有两份
 *
 * 改造前，这个算法在两个地方各写了一遍：
 *
 * - `packages/core/src/engine/world-manager.ts` 的 `normalizeLocations`
 * - `orchestrator/src/config-generator.mjs` 的 `finalizeLocations`
 *
 * 逐字相同，连错误都一样。而且**两边都没有测试** ——
 * 改错了不会红，只会让世界悄悄变形。
 *
 * 现在只有这一份。orchestrator 通过 tsx 加载 core 源码调用它
 * （跟 `scripts/rules.mjs` 加载 core 规则一样的方式），
 * 所以**世界生成**和**世界加载**走的是同一套逻辑。
 */

/** 去重但保持顺序 —— 邻接列表的顺序有意义（主区域要排在首位）。 */
function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

/**
 * 归一化世界区域列表。
 *
 * 做的事：
 *
 * 1. 补上缺失的中心区域（`centerLocationId`）—— 它是世界的公共枢纽
 * 2. 中心区域连到所有其它区域（星形拓扑）
 * 3. 其它区域至少连到中心区域
 * 4. 丢掉指向不存在区域 / 指向自己的邻接
 *
 * @param locations      world.json 里写的区域列表（可能是 undefined）
 * @param centerLocationId 中心区域的 id —— 世界的公共枢纽，角色在里面用点位寻址
 * @param worldName      世界名 —— 只在描述兜底时用
 * @param worldDescription 世界描述 —— 优先于生成的描述
 */
export function normalizeLocations(
  locations: LocationConfig[] | undefined,
  centerLocationId: string,
  worldName: string,
  worldDescription: string,
): LocationConfig[] {
  const authored = (Array.isArray(locations) ? locations : []).map((location) => ({
    ...location,
    adjacentLocations: Array.isArray(location.adjacentLocations)
      ? unique(location.adjacentLocations.filter(Boolean))
      : [],
    objects: Array.isArray(location.objects) ? location.objects : [],
  }));

  // 中心区域不算「真实区域」—— 它不参与区域之间的邻接计算。
  const authoredIds = authored
    .map((location) => location.id)
    .filter((locationId) => locationId && locationId !== centerLocationId);

  const hasCenter = authored.some((location) => location.id === centerLocationId);
  const withCenter = hasCenter
    ? authored
    : [
        {
          id: centerLocationId,
          name: "主区域",
          description:
            worldDescription ||
            (worldName ? `${worldName}中的公共活动区域` : "公共活动区域"),
          adjacentLocations: [...authoredIds],
          objects: [],
        },
        ...authored,
      ];

  const allIds = new Set(withCenter.map((location) => location.id));
  const hasAnyAuthoredAdjacency = withCenter.some(
    (location) =>
      location.id !== centerLocationId &&
      (location.adjacentLocations?.length ?? 0) > 0,
  );

  return withCenter.map((location) => {
    let adjacent = (location.adjacentLocations ?? []).filter(
      (adjacentId) => adjacentId !== location.id && allIds.has(adjacentId),
    );

    if (location.id === centerLocationId) {
      // 中心区域连到所有真实区域 —— 它是星形拓扑的中心。
      adjacent = unique([...adjacent, ...authoredIds]);
    } else if (adjacent.length === 0) {
      // 没写邻接的区域挂到中心区域；一个邻接都没有的话，全连接。
      adjacent = hasAnyAuthoredAdjacency
        ? [centerLocationId]
        : Array.from(allIds).filter((adjacentId) => adjacentId !== location.id);
    } else {
      // 已有邻接的：中心区域排首位。
      adjacent = unique([centerLocationId, ...adjacent]);
    }

    return {
      ...location,
      adjacentLocations: adjacent,
    };
  });
}
