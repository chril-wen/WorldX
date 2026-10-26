/**
 * 阶段 4 验证 —— 改造前后**逐字段等价**。
 *
 * ## 这个脚本证明什么
 *
 * 阶段 4 把「中心区域叫 main_area」这个写死的假设，
 * 换成了 world.json 声明的 `centerLocationId`。
 *
 * **唯一允许变的是「id 从哪来」，不是「id 是什么」。**
 * 所以对 4 个真实世界，改造前后加载出的区域配置必须**逐字段相等**。
 *
 * 基准用的是**改造前的字面实现**（照抄旧代码）——
 * 不是拿新实现给自己当基准（那样只能证明新实现自洽，
 * 证明不了行为没变）。
 *
 * 跑法：node scripts/verify-phase4.mjs
 */
import { readFileSync, existsSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, "..");

// ─── 基准：改造前的字面实现（照抄旧代码） ────────────────────────────────

function unique(values) {
  return Array.from(new Set(values));
}

function legacyNormalizeLocations(locations, worldName, worldDescription) {
  const authored = (Array.isArray(locations) ? locations : []).map((location) => ({
    ...location,
    adjacentLocations: Array.isArray(location.adjacentLocations)
      ? unique(location.adjacentLocations.filter(Boolean))
      : [],
    objects: Array.isArray(location.objects) ? location.objects : [],
  }));

  const authoredIds = authored
    .map((location) => location.id)
    .filter((locationId) => locationId && locationId !== "main_area");

  const hasMainArea = authored.some((location) => location.id === "main_area");
  const withMainArea = hasMainArea
    ? authored
    : [
        {
          id: "main_area",
          name: "主区域",
          description: worldDescription || `${worldName}中的公共活动区域`,
          adjacentLocations: [...authoredIds],
          objects: [],
        },
        ...authored,
      ];

  const allIds = new Set(withMainArea.map((location) => location.id));
  const hasAnyAuthoredAdjacency = withMainArea.some(
    (location) =>
      location.id !== "main_area" && (location.adjacentLocations?.length ?? 0) > 0,
  );

  return withMainArea.map((location) => {
    let adjacent = (location.adjacentLocations ?? []).filter(
      (adjacentId) => adjacentId !== location.id && allIds.has(adjacentId),
    );

    if (location.id === "main_area") {
      adjacent = unique([...adjacent, ...authoredIds]);
    } else if (adjacent.length === 0) {
      adjacent = hasAnyAuthoredAdjacency
        ? ["main_area"]
        : Array.from(allIds).filter((adjacentId) => adjacentId !== location.id);
    } else {
      adjacent = unique(["main_area", ...adjacent]);
    }

    return { ...location, adjacentLocations: adjacent };
  });
}

// ─── 新实现：从 core 源码加载 ───────────────────────────────────────────

const { tsImport } = await import("tsx/esm/api");
const coreNormalizer = await tsImport(
  pathToFileURL(join(PROJECT_DIR, "packages/core/src/engine/location-normalizer.ts")).href,
  import.meta.url,
);
const coreMigration = await tsImport(
  pathToFileURL(join(PROJECT_DIR, "packages/core/src/engine/world-migration.ts")).href,
  import.meta.url,
);
const coreContracts = await tsImport(
  pathToFileURL(join(PROJECT_DIR, "packages/core/src/contracts/world.ts")).href,
  import.meta.url,
);

const { normalizeLocations } = coreNormalizer;
const { migrateWorldConfig } = coreMigration;
const { DEFAULT_CENTER_LOCATION_ID, WORLD_SCHEMA_VERSION } = coreContracts;

// ─── 找真实世界 ─────────────────────────────────────────────────────────

const worldDirs = [];
for (const base of ["output/worlds", "library/worlds"]) {
  const dir = join(PROJECT_DIR, base);
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) {
    const cfg = join(dir, name, "config", "world.json");
    if (existsSync(cfg)) worldDirs.push({ name, configPath: cfg });
  }
}

if (worldDirs.length === 0) {
  console.error("找不到任何真实世界 —— 验证无从谈起。");
  process.exit(1);
}

let failures = 0;

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}`);
    console.log(`      实际: ${a}`);
    console.log(`      期望: ${b}`);
    failures++;
  }
}

console.log(`=== 阶段 4 验证：${worldDirs.length} 个真实世界 ===\n`);

for (const { name, configPath } of worldDirs) {
  console.log(`■ ${name}`);
  const raw = JSON.parse(readFileSync(configPath, "utf-8"));

  // 1. 迁移：旧世界补上 schemaVersion 和 centerLocationId
  const migrated = migrateWorldConfig(raw);
  check("迁移后 schemaVersion 是当前版本", migrated.schemaVersion, WORLD_SCHEMA_VERSION);
  check(
    "迁移后 centerLocationId 是默认值（旧世界没有这个字段）",
    migrated.centerLocationId,
    DEFAULT_CENTER_LOCATION_ID,
  );
  check(
    "迁移后 locations 数量不变",
    migrated.locations.length,
    (raw.locations || []).length,
  );

  // 2. 逐字段：除新增的两个字段外，原有内容不变
  //
  // **要按「raw 里的键」逐个比，不能把 migrated 删掉新字段后整体比** ——
  // 因为磁盘上的 world.json **可能已经是 v2**（迁移是在读取时生效的，
  // 但 `WorldManager.addLocation()` 会把内存态写回磁盘 —— 写回的东西
  // 已经带上了新字段）。那种情况下 raw 里也有 schemaVersion，
  // 删掉 migrated 的新字段再跟 raw 比，必然不等 —— 但那不是「丢数据」。
  //
  // 真正要守的是：**raw 里有的每个字段，迁移后都还在、且值一样**。
  const NEW_FIELDS = ["schemaVersion", "centerLocationId"];
  const originalFields = Object.fromEntries(
    Object.entries(raw).filter(([key]) => !NEW_FIELDS.includes(key)),
  );
  const migratedFields = Object.fromEntries(
    Object.entries(migrated).filter(([key]) => !NEW_FIELDS.includes(key)),
  );
  check("迁移不丢数据（除新增字段外逐字段相等）", migratedFields, originalFields);

  // 3. 归一化：改造前后逐字段相等
  const legacy = legacyNormalizeLocations(
    raw.locations,
    raw.worldName ?? "main_area",
    raw.worldDescription ?? "",
  );
  const actual = normalizeLocations(
    raw.locations,
    migrated.centerLocationId,
    raw.worldName ?? "",
    raw.worldDescription ?? "",
  );
  check("归一化结果与改造前逐字段相等", actual, legacy);

  // 4. 幂等
  const twice = migrateWorldConfig(migrated);
  check("迁移是幂等的", twice, migrated);

  // 5. 中心 id 确实在 locations 里
  check(
    "中心区域确实存在",
    actual.some((l) => l.id === migrated.centerLocationId),
    true,
  );

  // 6. 邻接图：中心区域连到所有其它区域
  //
  // **比集合，不比顺序** ——
  // 中心的邻接列表的顺序是「磁盘上的存储顺序」，
  // 而 `others` 是 locations 数组的顺序。两者都包含同样的区域，
  // 但顺序未必一致（真实世界的 center.adjacentLocations 里
  // `town_market_square` 排在末尾，而 locations 数组里它在中间）。
  //
  // 这条断言的本意是「中心连到所有其它区域」—— 顺序不是重点。
  // 顺序本身由上面「归一化结果与改造前逐字段相等」那条守住。
  const center = actual.find((l) => l.id === migrated.centerLocationId);
  const others = actual.filter((l) => l.id !== migrated.centerLocationId).map((l) => l.id);
  check(
    "中心区域连到所有其它区域",
    [...center.adjacentLocations].sort(),
    [...others].sort(),
  );

  console.log("");
}

// ─── 改中心 id 的场景：验证「静默失效」真的修好了 ──────────────────────

console.log("■ 造一个中心叫 town_square 的世界");
{
  const raw = {
    worldName: "测试世界",
    locations: [
      { id: "town_square", name: "中央广场", description: "", adjacentLocations: [], objects: [] },
      { id: "shop", name: "杂货铺", description: "", adjacentLocations: [], objects: [] },
    ],
  };
  const migrated = migrateWorldConfig({ ...raw, centerLocationId: "town_square" });
  check("中心 id 是 town_square", migrated.centerLocationId, "town_square");

  const locations = normalizeLocations(
    raw.locations,
    migrated.centerLocationId,
    raw.worldName,
    "",
  );
  check("没有合成 main_area", locations.some((l) => l.id === "main_area"), false);
  check(
    "其它区域挂到 town_square 上",
    locations.find((l) => l.id === "shop").adjacentLocations,
    ["town_square"],
  );
  check(
    "town_square 连到所有其它区域",
    locations.find((l) => l.id === "town_square").adjacentLocations,
    ["shop"],
  );
  console.log("");
}

console.log("=== 结果 ===");
if (failures === 0) {
  console.log("全部通过 ✅ —— 改造前后行为完全一致。");
  process.exit(0);
} else {
  console.log(`${failures} 项不一致 ❌`);
  process.exit(1);
}
