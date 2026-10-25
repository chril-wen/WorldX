import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { normalizeWorldDesign } from "./world-design-utils.mjs";
import { buildMainAreaPoints } from "./main-area-points.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

/**
 * 中心区域的 id —— 世界的公共枢纽。
 *
 * 角色在里面用 `mainAreaPointId` 点位寻址。
 *
 * 之前这个概念是写死的 `"main_area"` 字面量，散落在 79 处代码里。
 * 现在它由 world.json 的 `centerLocationId` 声明；生成新世界时
 * 用这个默认值，写进 world.json 之后由世界自己携带。
 *
 * 跟 core 的 `DEFAULT_CENTER_LOCATION_ID` 是同一个值 ——
 * 迁移函数给旧世界补的也是这个。
 */
const CENTER_LOCATION_ID = "main_area";

/**
 * 加载 core 的规则模块。
 *
 * ## 为什么 orchestrator 现在依赖 core 了
 *
 * 2.5 阶段刻意不依赖：当时只需要「一份规则名清单」，
 * 白名单是数据，校验在测试里做，orchestrator 的运行时依赖没变。
 *
 * 现在不一样了 —— 设计流程的规则是 **LLM 直出**的，
 * 而越界的值不会报错，只会让世界**静默崩坏**：
 * 实测 `emotion.decayRate = 1.8`，6 个 tick 后效价从 3 涨到 46875，
 * 全程零报错。engine 的 `mergeRules()` 会夹住它，世界不会崩 ——
 * 但 **world.json 里存的 1.8 和实际在跑的 1.0 不是一回事**。
 *
 * 这正是 2.5 汇报里点名的「规则有一半是假的」那类问题：
 * 规则必须**改了立刻生效，且存的和跑的是同一个值**。
 *
 * 所以写盘前要把规则规范化成**实际生效的值**。
 * 这需要 core 的真实钳制逻辑，一份清单做不到。
 *
 * 加载 core 的**编译产物**（不是源码），不引入新的依赖。
 *
 * @returns core 的规则模块，或 null（加载失败不致命）
 */
let coreRulesCache;
async function loadCoreRules() {
  if (coreRulesCache !== undefined) return coreRulesCache;
  try {
    const mod = await import(
      pathToFileURL(
        join(
          __dirname,
          "..",
          "..",
          "packages",
          "core",
          "dist",
          "engine",
          "rules.js",
        ),
      ).href
    );
    coreRulesCache = mod;
  } catch (err) {
    // 加载不了不该让「创建世界」失败 —— engine 里还有一层钳制兜底。
    console.warn(
      `[ConfigGenerator] 规则规范化跳过（core 加载失败）：${err?.message ?? err}`,
    );
    coreRulesCache = null;
  }
  return coreRulesCache;
}

/**
 * 加载 core 的区域归一化实现。
 *
 * ## 为什么这里必须用 core 那一份
 *
 * 改造前，这个算法在 core 和 orchestrator 各写了一遍 ——
 * **逐字相同，连错误都一样**。只改一边会导致：
 *
 * - 世界**生成**出来的主区域 id 跟世界**加载**时算的不一样
 * - 两边的邻接规则悄悄分叉
 *
 * 现在只有 core 一份实现。orchestrator 直接吃它的**源码**
 * （走 tsx），跟 vitest 走的是同一份逻辑 ——
 * 不用先 `npm run build:core`，也不会出现「dist 是旧的」。
 *
 * 加载失败是**致命的**（不是降级）—— 没有归一化就没有中心区域，
 * 生成出来的世界是残的。宁可让创建失败，也不要悄悄产出一个坏世界。
 */
let coreLocationsCache;
async function loadCoreLocations() {
  if (coreLocationsCache !== undefined) return coreLocationsCache;
  const coreDir = join(__dirname, "..", "..", "packages", "core", "src");
  const corePath = join(coreDir, "engine", "location-normalizer.ts");
  const contractsPath = join(coreDir, "contracts", "world.ts");
  try {
    const { tsImport } = await import("tsx/esm/api");
    const [locations, contracts] = await Promise.all([
      tsImport(pathToFileURL(corePath).href, import.meta.url),
      tsImport(pathToFileURL(contractsPath).href, import.meta.url),
    ]);
    coreLocationsCache = {
      normalizeLocations: locations.normalizeLocations,
      WORLD_SCHEMA_VERSION: contracts.WORLD_SCHEMA_VERSION,
      DEFAULT_CENTER_LOCATION_ID: contracts.DEFAULT_CENTER_LOCATION_ID,
    };
  } catch (err) {
    throw new Error(
      `[ConfigGenerator] 加载 core 的区域归一化实现失败（${corePath}）：${err?.message ?? err}`,
    );
  }
  return coreLocationsCache;
}

/**
 * 把规则片段规范化成「实际生效的值」。
 *
 * 做两件事：
 * 1. 越界的值夹回合理区间（并把问题报出来）
 * 2. **只保留显式写过的键** —— `mergeRules()` 会补全 37 个默认值，
 *    全塞进 world.json 就违背了「只写要改的项」的约定
 *
 * @param rawRules 原始规则片段（可能 null）
 * @returns 规范化后的规则片段，或 null
 */
async function normalizeRulesForWrite(rawRules) {
  if (!rawRules || typeof rawRules !== "object" || Array.isArray(rawRules)) {
    return null;
  }
  const core = await loadCoreRules();
  if (!core) return rawRules;

  // 先看原始值有没有问题 —— 夹住之前先说清楚。
  const issues = core.validateRawRules(rawRules);
  if (issues.length > 0) {
    console.warn("[ConfigGenerator] 规则有问题，已夹回合理区间：");
    for (const issue of issues) console.warn(`  - ${issue}`);
  }

  const clamped = core.mergeRules(rawRules);
  const out = {};
  for (const [group, groupRaw] of Object.entries(rawRules)) {
    if (!groupRaw || typeof groupRaw !== "object" || Array.isArray(groupRaw)) {
      continue;
    }
    const picked = {};
    for (const key of Object.keys(groupRaw)) {
      if (!(key in (clamped[group] ?? {}))) continue;
      picked[key] = clamped[group][key];
    }
    if (Object.keys(picked).length > 0) out[group] = picked;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export async function generateConfigs(worldDesign, worldDir, options = {}) {
  const normalizedDesign = normalizeWorldDesign(worldDesign);
  // 规则在写盘前规范化 —— world.json 存的必须是实际在跑的值。
  const worldRules = await normalizeRulesForWrite(normalizedDesign.rules);
  // schema 版本号跟 core 一致 —— 从 core 取，不写死。
  const { WORLD_SCHEMA_VERSION } = await loadCoreLocations();
  const originalPrompt =
    typeof options.originalPrompt === "string" && options.originalPrompt.trim()
      ? options.originalPrompt.trim()
      : undefined;
  const mapDir = join(worldDir, "map");
  const configDir = join(worldDir, "config");
  mkdirSync(configDir, { recursive: true });

  const tmjPath = join(mapDir, "06-final.tmj");
  const tmj = JSON.parse(readFileSync(tmjPath, "utf-8"));
  const regionsLayer = tmj.layers.find((l) => l.name === "regions");
  const objectsLayer = tmj.layers.find((l) => l.name === "interactive_objects");
  const collisionLayer = tmj.layers.find((l) => l.name === "collision");

  const tmjRegions = regionsLayer?.objects || [];
  const tmjObjects = objectsLayer?.objects || [];
  const primaryPublicHubRegion = findPrimaryPublicHubRegion(
    tmjRegions,
    normalizedDesign,
    tmj,
  );
  const mainAreaPointRegions = primaryPublicHubRegion
    ? tmjRegions.filter((region) => region !== primaryPublicHubRegion)
    : tmjRegions;
  const mainAreaPoints = buildMainAreaPoints({
    tmj,
    collisionLayer,
    regions: mainAreaPointRegions,
    elementObjects: tmjObjects,
  });

  const locations = await buildLocations(tmjRegions, tmjObjects, normalizedDesign, tmj, {
    primaryPublicHubRegion,
  });
  const worldActions = buildWorldActions(normalizedDesign);
  const sceneConfig = {
    sceneType: normalizedDesign.sceneType,
    startTime: normalizedDesign.timeConfig.startTime,
    tickDurationMinutes: normalizedDesign.timeConfig.tickDurationMinutes,
    maxTicks: normalizedDesign.timeConfig.maxTicks,
    displayFormat: normalizedDesign.timeConfig.displayFormat,
    description: normalizedDesign.worldDescription,
    multiDay: normalizedDesign.multiDay,
    worldName: normalizedDesign.worldName,
    worldDescription: normalizedDesign.worldDescription,
    characterCount: normalizedDesign.characters.length,
  };
  const worldSize = {
    width: tmj.width * tmj.tilewidth,
    height: tmj.height * tmj.tileheight,
    tileSize: tmj.tilewidth,
    gridWidth: tmj.width,
    gridHeight: tmj.height,
  };

  const worldConfig = {
    // 中心区域的 id —— 世界的公共枢纽。
    // 插件可以改（接管世界身份）；缺失时由迁移函数补默认值。
    centerLocationId: CENTER_LOCATION_ID,
    worldName: normalizedDesign.worldName,
    worldDescription: normalizedDesign.worldDescription,
    worldSocialContext: normalizedDesign.worldSocialContext || normalizedDesign.worldDescription,
    contentLanguage: normalizedDesign.contentLanguage || undefined,
    originalPrompt,
    scene: {
      sceneType: normalizedDesign.sceneType,
      startTime: normalizedDesign.timeConfig.startTime,
      tickDurationMinutes: normalizedDesign.timeConfig.tickDurationMinutes,
      maxTicks: normalizedDesign.timeConfig.maxTicks,
      displayFormat: normalizedDesign.timeConfig.displayFormat,
      description: normalizedDesign.worldDescription,
      multiDay: normalizedDesign.multiDay,
    },
    worldActions,
    locations,
    mainAreaPoints,
    worldSize,
    // Rich world fields
    economics: normalizedDesign.economics || null,
    weather: normalizedDesign.weather || null,
    hearsay: normalizedDesign.hearsay || null,
    // 世界规则 —— 只写要改的项，其余走 core 的默认值。
    // 设计流程或插件可以在这里注入规则，让世界「一出生就带着某种气质」。
    // 写盘前已规范化（越界的值夹回区间）—— 存的就是跑的。
    rules: worldRules || null,
    metadata: {
      worldName: normalizedDesign.worldName,
      worldDescription: normalizedDesign.worldDescription,
      worldSocialContext: normalizedDesign.worldSocialContext || normalizedDesign.worldDescription,
      originalPrompt,
      sceneType: normalizedDesign.sceneType,
      timeConfig: normalizedDesign.timeConfig,
      multiDay: normalizedDesign.multiDay,
      mapPlan: normalizedDesign.mapPlan,
    },
  };

  // 注意：world.json **在这里不写** —— 要等插件的 extendWorldConfig 钩子跑完。
  //
  // 之前是直接 writeFileSync 在这个位置，结果插件改的东西全丢了：
  // 钩子拿到的是内存里的对象，磁盘上的 world.json 早写好了。
  // 写盘挪到函数末尾（见下方），那时代码已经跑完插件。

  const charactersDir = join(configDir, "characters");
  mkdirSync(charactersDir, { recursive: true });

  const charsDir = join(worldDir, "characters");
  let generatedChars = [];
  const charsJsonPath = join(charsDir, "characters.json");
  if (existsSync(charsJsonPath)) {
    generatedChars = JSON.parse(readFileSync(charsJsonPath, "utf-8"));
  }

  const startPositions = findStartPositions(
    collisionLayer?.data || [],
    tmj.width,
    tmj.height,
    tmj.tilewidth,
    tmjRegions,
    normalizedDesign.characters.length
  );

  // 角色级规则也要规范化 —— 跟世界级同一个道理。
  // 在 map 之前先把所有角色的 rules 备好（map 回调是同步的）。
  const characterRules = await Promise.all(
    normalizedDesign.characters.map((charDesign) =>
      normalizeRulesForWrite(charDesign?.rules),
    ),
  );

  const characterConfigs = normalizedDesign.characters.map((charDesign, i) => {
    const genChar = generatedChars[i];
    const charId = genChar?.id || `char_${i + 1}`;

    const anchor = charDesign.anchor || undefined;
    let startPos = CENTER_LOCATION_ID;
    if (anchor) {
      const anchoredPos = resolveAnchoredStartPosition(
        anchor,
        tmjRegions,
        tmjObjects,
        collisionLayer?.data || [],
        tmj.width,
        tmj.height,
        tmj.tilewidth,
        mainAreaPoints,
      );
      if (anchoredPos) startPos = anchoredPos;
    }

    // Rich world: resolve relationships for this character
    const relData = buildCharacterRelationships(charDesign, normalizedDesign.relationships);
    const initialMemories = buildCharacterMemories(charDesign, normalizedDesign.relationships);

    const iconicCues = normalizeIconicCues(charDesign.iconicCues);
    const canonicalRefs = normalizeCanonicalRefs(charDesign.canonicalRefs);

    const backgroundMemories = (charDesign.initialMemories || []).map((content) => ({
      type: "reflection",
      content,
      importance: 6,
      tags: ["background"],
    }));

    const signatureMemories = (canonicalRefs?.signatureMoments || []).map((content) => ({
      type: "reflection",
      content,
      importance: 8,
      tags: ["background", "signature_moment"],
    }));

    const config = {
      id: charId,
      name: charDesign.name,
      role: charDesign.role,
      personality: charDesign.personality,
      appearanceHint:
        typeof charDesign.appearanceHint === "string" ? charDesign.appearanceHint : "",
      motivation: charDesign.motivation,
      socialStyle: charDesign.socialStyle,
      startPosition: startPos,
      initialMemories: [...backgroundMemories, ...signatureMemories, ...initialMemories],
      // Rich world: relationship values and world social context
      affinity: relData.affinity,
      tension: relData.tension,
      worldSocialContext: normalizedDesign.worldSocialContext || "",
    };

    if (anchor) config.anchor = anchor;
    if (iconicCues) config.iconicCues = iconicCues;
    if (canonicalRefs) config.canonicalRefs = canonicalRefs;
    // 角色级规则覆盖 —— 设计时可以为某个角色指定特殊气质
    // （比如「这个角色记性特别短」）。只写要改的项，其余继承世界级。
    // 写盘前已规范化（越界的值夹回区间）—— 存的就是跑的。
    if (charDesign.rules && typeof charDesign.rules === "object") {
      config.rules = characterRules[i];
    }

    // 写盘挪到后面 —— 要等插件的 extendWorldConfig 钩子跑完。
    // 插件可能改角色配置，在这儿写就把它改的丢了。
    return config;
  });

  // 插件钩子：让插件能增补世界配置。
  //
  // **必须在写盘之前** —— 插件改的是内存里的对象，
  // 写盘早一步的话，插件的改动全丢。
  let finalWorldConfig = worldConfig;
  let finalCharacterConfigs = characterConfigs;
  let finalSceneConfig = sceneConfig;

  if (typeof options.extendConfig === "function") {
    const extended = await options.extendConfig({
      worldConfig,
      characterConfigs,
      sceneConfig,
    });
    if (extended) {
      finalWorldConfig = extended.worldConfig ?? worldConfig;
      finalCharacterConfigs = extended.characterConfigs ?? characterConfigs;
      finalSceneConfig = extended.sceneConfig ?? sceneConfig;
    }
  }

  // schemaVersion 在插件钩子**之后**盖上 ——
  // 版本号是 orchestrator 的职责，插件不该改它
  // （插件可以改 centerLocationId，那是世界身份）。
  finalWorldConfig = {
    ...finalWorldConfig,
    schemaVersion: WORLD_SCHEMA_VERSION,
  };

  for (const config of finalCharacterConfigs) {
    writeFileSync(
      join(charactersDir, `${config.id}.json`),
      JSON.stringify(config, null, 2),
    );
  }

  writeFileSync(
    join(configDir, "world.json"),
    JSON.stringify(finalWorldConfig, null, 2),
  );
  writeFileSync(
    join(configDir, "scene.json"),
    JSON.stringify(finalSceneConfig, null, 2),
  );

  console.log(`[ConfigGenerator] Generated configs:`);
  console.log(`  world.json: ${locations.length} locations`);
  console.log(`  characters: ${finalCharacterConfigs.length} configs`);
  console.log(`  scene.json: ${finalSceneConfig.sceneType} scene`);

  return {
    worldConfig: finalWorldConfig,
    characterConfigs: finalCharacterConfigs,
    sceneConfig: finalSceneConfig,
  };
}

async function buildLocations(tmjRegions, tmjObjects, worldDesign, tmj, options = {}) {
  const designedRegions = worldDesign.regions || worldDesign.locations || [];
  const designedElements = worldDesign.interactiveElements || [];
  const primaryPublicHubRegion = options.primaryPublicHubRegion || null;
  const primaryPublicHubId = primaryPublicHubRegion
    ? getRegionId(primaryPublicHubRegion)
    : null;

  // Build element-based objects that belong to main_area
  const elementObjects = buildElementObjects(designedElements, tmjObjects);

  if (tmjRegions.length > 0) {
    const primaryHubObjects = primaryPublicHubRegion
      ? buildObjectsForRegion(CENTER_LOCATION_ID, primaryPublicHubRegion, tmjObjects, designedRegions)
      : [];
    const authoredLocations = tmjRegions
      .filter((region) => getRegionId(region) !== primaryPublicHubId)
      .map((region) => {
        const props = getObjectProperties(region);
        const regionId = getRegionId(region);
        const designedLoc = findMatchingLocation(regionId, props, designedRegions);
        const regionObjects = buildObjectsForRegion(regionId, region, tmjObjects, designedRegions);

        const adjacentLocations = tmjRegions
          .filter((other) => other !== region && regionsAreAdjacent(region, other, tmj.tilewidth * 3))
          .map((other) =>
            getRegionId(other) === primaryPublicHubId ? CENTER_LOCATION_ID : getRegionId(other),
          );

        const indoor = designedLoc?.indoor === true || designedLoc?.indoor === false
          ? designedLoc.indoor
          : undefined;

        const result = {
          id: regionId,
          name: region.name || designedLoc?.name || regionId,
          description: props.description || designedLoc?.description || "",
          adjacentLocations,
          objects: regionObjects,
        };
        if (indoor !== undefined) result.indoor = indoor;
        return result;
      });

    const { normalizeLocations } = await loadCoreLocations();
    const locations = normalizeLocations(
      authoredLocations,
      CENTER_LOCATION_ID,
      worldDesign.worldName || "Main Area",
      worldDesign.worldDescription || "",
    );

    // Attach public-hub and element objects to main_area
    if (primaryHubObjects.length > 0 || elementObjects.length > 0) {
      const mainArea = locations.find((l) => l.id === CENTER_LOCATION_ID);
      if (mainArea) {
        mainArea.objects = [...mainArea.objects, ...primaryHubObjects, ...elementObjects];
      }
    }

    return locations;
  }

  const mainObjects = [
    ...designedRegions.flatMap((loc) =>
      (loc.interactions || []).map((inter) => ({
        id: inter.id || `${loc.id}_action`,
        name: inter.name,
        locationId: CENTER_LOCATION_ID,
        defaultState: "available",
        capacity: 2,
        interactions: [
          {
            id: inter.id,
            name: inter.name,
            description: inter.description || "",
            availableWhenState: inter.availableWhenState || ["available"],
            duration: inter.duration || 2,
            effects: inter.effects || [],
            repeatable: inter.repeatable ?? true,
            ...(inter.requiresAnchor === true ? { requiresAnchor: true } : {}),
          },
        ],
      }))
    ),
    ...elementObjects,
  ];

  const { normalizeLocations } = await loadCoreLocations();
  return normalizeLocations(
    [
      {
        id: CENTER_LOCATION_ID,
        name: worldDesign.worldName || "Main Area",
        description: worldDesign.worldDescription || "",
        adjacentLocations: [],
        objects: mainObjects,
      },
    ],
    CENTER_LOCATION_ID,
    worldDesign.worldName || "Main Area",
    worldDesign.worldDescription || "",
  );
}

function buildObjectsForRegion(locationId, region, tmjObjects, designedRegions) {
  const props = getObjectProperties(region);
  const regionId = getRegionId(region);
  const designedLoc = findMatchingLocation(regionId, props, designedRegions);
  const regionObjects = tmjObjects
    .filter((obj) => isObjectInRegion(obj, region))
    .map((obj) => {
      const objProps = getObjectProperties(obj);

      let interactions = [];
      if (objProps.interactions) {
        try {
          interactions = JSON.parse(objProps.interactions);
        } catch {
          interactions = [];
        }
      }

      return {
        id:
          objProps.objectId ||
          obj.name?.toLowerCase().replace(/\s+/g, "_") ||
          `obj_${obj.id}`,
        name: obj.name || "Unknown Object",
        locationId,
        defaultState: "available",
        capacity: 1,
        interactions: interactions.map((inter) => ({
          id: inter.id || inter.name?.toLowerCase().replace(/\s+/g, "_"),
          name: inter.name || inter.id,
          description: inter.description || "",
          availableWhenState: inter.availableWhenState || ["available"],
          duration: inter.duration || 2,
          effects: inter.effects || [{ type: "character_need", target: "curiosity", value: 5 }],
          repeatable: inter.repeatable ?? true,
        })),
      };
    });

  if (designedLoc?.interactions && regionObjects.length === 0) {
    designedLoc.interactions.forEach((inter) => {
      regionObjects.push({
        id: inter.id || `${regionId}_action`,
        name: inter.name,
        locationId,
        defaultState: "available",
        capacity: 2,
        interactions: [
          {
            id: inter.id,
            name: inter.name,
            description: inter.description || "",
            availableWhenState: inter.availableWhenState || ["available"],
            duration: inter.duration || 2,
            effects: inter.effects || [],
            repeatable: inter.repeatable ?? true,
            ...(inter.requiresAnchor === true ? { requiresAnchor: true } : {}),
          },
        ],
      });
    });
  }

  return regionObjects;
}

function buildElementObjects(designedElements, tmjObjects) {
  return designedElements.map((element) => {
    const interactions = (element.interactions || []).map((inter) => ({
      id: inter.id || `${element.id}_action`,
      name: inter.name || inter.id,
      description: inter.description || "",
      availableWhenState: inter.availableWhenState || ["available"],
      duration: inter.duration || 2,
      effects: inter.effects || [],
      repeatable: inter.repeatable ?? true,
      ...(inter.requiresAnchor === true ? { requiresAnchor: true } : {}),
    }));

    return {
      id: element.id,
      name: element.name,
      locationId: CENTER_LOCATION_ID,
      defaultState: "available",
      capacity: 2,
      interactions,
    };
  });
}

function buildWorldActions(worldDesign) {
  return (worldDesign.worldActions || []).map((action) => ({
    id: action.id,
    name: action.name,
    description: action.description || "",
    availableWhenState: action.availableWhenState || ["available"],
    duration: action.duration || 2,
    effects: action.effects || [],
    repeatable: action.repeatable ?? true,
  }));
}

const PUBLIC_HUB_KEYWORDS = [
  "common",
  "central",
  "hall",
  "lobby",
  "plaza",
  "street",
  "activity",
  "public",
  "square",
  "atrium",
  "courtyard",
  "公共",
  "中央",
  "大厅",
  "广场",
  "主街",
  "活动区",
  "公区",
  "中庭",
  "院落",
];

const PRIVATE_REGION_KEYWORDS = [
  "cell",
  "room",
  "bedroom",
  "private",
  "office",
  "storage",
  "toilet",
  "bathroom",
  "kitchen",
  "hut",
  "house",
  "囚室",
  "房间",
  "卧室",
  "牢房",
  "办公室",
  "储藏",
  "厕所",
  "卫生间",
  "厨房",
  "小屋",
];

const PUBLIC_HUB_MIN_AREA_RATIO = parseFloat(
  process.env.PRIMARY_PUBLIC_HUB_MIN_AREA_RATIO || "0.08",
);
const PUBLIC_HUB_MIN_DIMENSION_TILES = parseInt(
  process.env.PRIMARY_PUBLIC_HUB_MIN_DIMENSION_TILES || "8",
  10,
);

function findPrimaryPublicHubRegion(tmjRegions, worldDesign, tmj) {
  if (!Array.isArray(tmjRegions) || tmjRegions.length === 0 || !tmj) {
    return null;
  }

  const anchoredRegionIds = getAnchoredRegionIds(worldDesign);
  const worldArea = Math.max(1, (tmj.width || 0) * (tmj.height || 0) * (tmj.tilewidth || 32) ** 2);
  const minDimensionPx = (tmj.tilewidth || 32) * PUBLIC_HUB_MIN_DIMENSION_TILES;
  const candidates = tmjRegions.filter((region) => {
    const identifiers = getRegionIdentifiers(region);
    if (identifiers.some((id) => anchoredRegionIds.has(id))) {
      return false;
    }

    const text = getRegionSearchText(region, worldDesign);
    if (!containsKeyword(text, PUBLIC_HUB_KEYWORDS)) {
      return false;
    }
    if (containsKeyword(text, PRIVATE_REGION_KEYWORDS)) {
      return false;
    }

    const area = getRegionArea(region);
    const areaRatio = area / worldArea;
    const hasLargeArea = areaRatio >= PUBLIC_HUB_MIN_AREA_RATIO;
    const hasLargeDimensions =
      (region.width || 0) >= minDimensionPx && (region.height || 0) >= minDimensionPx;
    return hasLargeArea || hasLargeDimensions;
  });

  if (candidates.length === 0) {
    return null;
  }

  return candidates.sort((a, b) => getRegionArea(b) - getRegionArea(a))[0];
}

function getAnchoredRegionIds(worldDesign) {
  const anchoredIds = new Set();
  for (const character of worldDesign.characters || []) {
    const anchor = character.anchor;
    if (anchor?.type !== "region" || typeof anchor.targetId !== "string") {
      continue;
    }
    anchoredIds.add(normalizeIdentifier(anchor.targetId));
  }
  return anchoredIds;
}

function getRegionSearchText(region, worldDesign) {
  const props = getObjectProperties(region);
  const regionId = getRegionId(region);
  const designedLoc = findMatchingLocation(
    regionId,
    props,
    worldDesign.regions || worldDesign.locations || [],
  );
  return [
    regionId,
    region.name,
    props.name,
    props.description,
    designedLoc?.id,
    designedLoc?.name,
    designedLoc?.description,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function containsKeyword(text, keywords) {
  return keywords.some((keyword) => text.includes(keyword.toLowerCase()));
}

function getRegionIdentifiers(region) {
  const props = getObjectProperties(region);
  return [
    props.id,
    region.name,
    region.name?.toLowerCase().replace(/\s+/g, "_"),
    `region_${region.id}`,
  ]
    .filter(Boolean)
    .map(normalizeIdentifier);
}

function getRegionArea(region) {
  return Math.max(0, region.width || 0) * Math.max(0, region.height || 0);
}

function getObjectProperties(obj) {
  const props = {};
  (obj.properties || []).forEach((p) => {
    props[p.name] = p.value;
  });
  return props;
}

function getRegionId(region) {
  const props = getObjectProperties(region);
  return props.id || region.name?.toLowerCase().replace(/\s+/g, "_") || `region_${region.id}`;
}

function normalizeIdentifier(value) {
  return String(value).trim().toLowerCase().replace(/\s+/g, "_");
}

function findMatchingLocation(regionId, regionProps, designedLocations) {
  return designedLocations.find((loc) => {
    if (loc.id === regionId) return true;
    const locName = loc.name?.toLowerCase();
    const regName = regionProps.description?.toLowerCase() || regionId.toLowerCase();
    return locName && (regName.includes(locName) || locName.includes(regName));
  });
}

function isObjectInRegion(obj, region) {
  const ox = obj.x + (obj.width || 0) / 2;
  const oy = obj.y + (obj.height || 0) / 2;
  return (
    ox >= region.x &&
    ox <= region.x + region.width &&
    oy >= region.y &&
    oy <= region.y + region.height
  );
}

function regionsAreAdjacent(a, b, threshold) {
  const aCx = a.x + a.width / 2;
  const aCy = a.y + a.height / 2;
  const bCx = b.x + b.width / 2;
  const bCy = b.y + b.height / 2;
  const dist = Math.sqrt((aCx - bCx) ** 2 + (aCy - bCy) ** 2);
  const minDist = (Math.max(a.width, a.height) + Math.max(b.width, b.height)) / 2;
  return dist < minDist + threshold;
}

function unique(values) {
  return Array.from(new Set(values));
}

function findStartPositions(collisionData, gridWidth, gridHeight, tileSize, regions, count) {
  const walkable = [];
  for (let y = 0; y < gridHeight; y++) {
    for (let x = 0; x < gridWidth; x++) {
      if (collisionData[y * gridWidth + x] === 0) {
        walkable.push({ x, y });
      }
    }
  }

  const preferredWalkable = getLargestWalkableComponent(collisionData, gridWidth, gridHeight);
  const spawnableWalkable =
    preferredWalkable.size > 0
      ? walkable.filter(({ x, y }) => preferredWalkable.has(`${x},${y}`))
      : walkable;

  if (spawnableWalkable.length === 0) {
    return Array.from({ length: count }, (_, i) => ({
      tileX: Math.floor(gridWidth / 2) + i,
      tileY: Math.floor(gridHeight / 2),
      pixelX: (Math.floor(gridWidth / 2) + i) * tileSize,
      pixelY: Math.floor(gridHeight / 2) * tileSize,
      locationId: regions[0]?.name?.toLowerCase().replace(/\s+/g, "_") || CENTER_LOCATION_ID,
    }));
  }

  const step = Math.max(1, Math.floor(spawnableWalkable.length / (count + 1)));
  return Array.from({ length: count }, (_, i) => {
    const pos = spawnableWalkable[Math.min((i + 1) * step, spawnableWalkable.length - 1)];

    let locationId = CENTER_LOCATION_ID;
    if (regions.length > 0) {
      const px = pos.x * tileSize;
      const py = pos.y * tileSize;
      for (const region of regions) {
        if (
          px >= region.x &&
          px <= region.x + (region.width || 0) &&
          py >= region.y &&
          py <= region.y + (region.height || 0)
        ) {
          const props = {};
          (region.properties || []).forEach((p) => {
            props[p.name] = p.value;
          });
          locationId =
            props.id || region.name?.toLowerCase().replace(/\s+/g, "_") || locationId;
          break;
        }
      }
    }

    return {
      tileX: pos.x,
      tileY: pos.y,
      pixelX: pos.x * tileSize,
      pixelY: pos.y * tileSize,
      locationId,
    };
  });
}

function getLargestWalkableComponent(collisionData, gridWidth, gridHeight) {
  const walkable = new Set();
  for (let y = 0; y < gridHeight; y++) {
    for (let x = 0; x < gridWidth; x++) {
      if (collisionData[y * gridWidth + x] === 0) {
        walkable.add(`${x},${y}`);
      }
    }
  }

  if (walkable.size === 0) {
    return new Set();
  }

  const visited = new Set();
  let largest = new Set();

  for (const key of walkable) {
    if (visited.has(key)) continue;

    const component = new Set();
    const queue = [key];
    visited.add(key);

    while (queue.length > 0) {
      const currentKey = queue.shift();
      component.add(currentKey);
      const [x, y] = currentKey.split(",").map(Number);
      const neighbors = [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ];

      for (const [nx, ny] of neighbors) {
        const neighborKey = `${nx},${ny}`;
        if (!walkable.has(neighborKey) || visited.has(neighborKey)) continue;
        visited.add(neighborKey);
        queue.push(neighborKey);
      }
    }

    if (component.size > largest.size) {
      largest = component;
    }
  }

  return largest;
}

function resolveAnchoredStartPosition(anchor, tmjRegions, tmjObjects, collisionData, gridWidth, gridHeight, tileSize, mainAreaPoints) {
  if (anchor.type === "region") {
    const region = tmjRegions.find((r) => {
      const props = {};
      (r.properties || []).forEach((p) => { props[p.name] = p.value; });
      return props.id === anchor.targetId || r.name?.toLowerCase().replace(/\s+/g, "_") === anchor.targetId;
    });
    if (region) {
      const centerX = region.x + region.width / 2;
      const centerY = region.y + region.height / 2;
      const gx = Math.floor(centerX / tileSize);
      const gy = Math.floor(centerY / tileSize);
      const walkable = findNearestWalkableTile(gx, gy, collisionData, gridWidth, gridHeight, 5);
      if (walkable) {
        return {
          tileX: walkable.x,
          tileY: walkable.y,
          pixelX: walkable.x * tileSize + tileSize / 2,
          pixelY: walkable.y * tileSize + tileSize / 2,
          locationId: anchor.targetId,
        };
      }
    }
  } else if (anchor.type === "element") {
    const elementPointId = `element_${anchor.targetId}`;
    const point = mainAreaPoints.find((p) => p.id === elementPointId);
    if (point) {
      const gx = Math.floor(point.x / tileSize);
      const gy = Math.floor(point.y / tileSize);
      return {
        tileX: gx,
        tileY: gy,
        pixelX: point.x,
        pixelY: point.y,
        locationId: CENTER_LOCATION_ID,
        mainAreaPointId: elementPointId,
      };
    }
    // Fallback: find element in TMJ objects, place outside its bounding box
    const obj = tmjObjects.find((o) => {
      const props = {};
      (o.properties || []).forEach((p) => { props[p.name] = p.value; });
      return props.objectId === anchor.targetId;
    });
    if (obj) {
      const approachX = obj.x + (obj.width || 0) / 2;
      const approachY = obj.y + (obj.height || 0) + tileSize;
      const startGx = Math.floor(approachX / tileSize);
      const startGy = Math.floor(approachY / tileSize);
      const walkable = findNearestWalkableTileOutsideBox(
        startGx, startGy, obj, collisionData, gridWidth, gridHeight, tileSize, 8,
      );
      if (walkable) {
        return {
          tileX: walkable.x,
          tileY: walkable.y,
          pixelX: walkable.x * tileSize + tileSize / 2,
          pixelY: walkable.y * tileSize + tileSize / 2,
          locationId: CENTER_LOCATION_ID,
        };
      }
    }
  }
  return null;
}

function findNearestWalkableTile(cx, cy, collisionData, gridWidth, gridHeight, maxRadius) {
  for (let r = 0; r <= maxRadius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= gridWidth || y >= gridHeight) continue;
        if (collisionData[y * gridWidth + x] === 0) {
          return { x, y };
        }
      }
    }
  }
  return null;
}

function findNearestWalkableTileOutsideBox(cx, cy, box, collisionData, gridWidth, gridHeight, tileSize, maxRadius) {
  const margin = tileSize * 0.5;
  const boxLeft = (box.x || 0) - margin;
  const boxTop = (box.y || 0) - margin;
  const boxRight = (box.x || 0) + (box.width || 0) + margin;
  const boxBottom = (box.y || 0) + (box.height || 0) + margin;

  for (let r = 0; r <= maxRadius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= gridWidth || y >= gridHeight) continue;
        if (collisionData[y * gridWidth + x] !== 0) continue;
        const px = x * tileSize + tileSize / 2;
        const py = y * tileSize + tileSize / 2;
        if (px >= boxLeft && px <= boxRight && py >= boxTop && py <= boxBottom) continue;
        return { x, y };
      }
    }
  }
  return null;
}

function toStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => v.length > 0);
}

function normalizeIconicCues(raw) {
  if (!raw || typeof raw !== "object") return null;
  const speechQuirks = toStringArray(raw.speechQuirks);
  const catchphrases = toStringArray(raw.catchphrases).slice(0, 2);
  const behavioralTics = toStringArray(raw.behavioralTics);
  if (speechQuirks.length === 0 && catchphrases.length === 0 && behavioralTics.length === 0) {
    return null;
  }
  return { speechQuirks, catchphrases, behavioralTics };
}

function normalizeCanonicalRefs(raw) {
  if (!raw || typeof raw !== "object") return null;
  const source = typeof raw.source === "string" ? raw.source.trim() : "";
  const keyRelationships = toStringArray(raw.keyRelationships);
  const signatureMoments = toStringArray(raw.signatureMoments).slice(0, 2);
  if (!source && keyRelationships.length === 0 && signatureMoments.length === 0) {
    return null;
  }
  return {
    source: source || undefined,
    keyRelationships,
    signatureMoments,
  };
}

/**
 * Extract relationship values for a single character.
 * Returns affinity (0-5, default 2) and tension (0-5, default 0).
 * A character may appear in multiple relationships; average them.
 */
function buildCharacterRelationships(charDesign, relationships) {
  const name = charDesign.name?.trim();
  if (!name || !Array.isArray(relationships)) {
    return { affinity: 2, tension: 0 };
  }
  const relevant = relationships.filter(
    (r) => r.charA === name || r.charB === name,
  );
  if (relevant.length === 0) return { affinity: 2, tension: 0 };
  const avgAffinity = Math.round(relevant.reduce((s, r) => s + (r.affinity ?? 2), 0) / relevant.length);
  const avgTension = Math.round(relevant.reduce((s, r) => s + (r.tension ?? 0), 0) / relevant.length);
  return {
    affinity: Math.max(0, Math.min(5, avgAffinity)),
    tension: Math.max(0, Math.min(5, avgTension)),
  };
}

/**
 * Build relationship-note memories from the relationships array.
 */
function buildCharacterMemories(charDesign, relationships) {
  const name = charDesign.name?.trim();
  if (!name || !Array.isArray(relationships)) return [];
  return relationships
    .filter((r) => (r.charA === name || r.charB === name) && r.note)
    .map((r) => {
      const other = r.charA === name ? r.charB : r.charA;
      return {
        type: "reflection",
        content: `和${other}的关系：${r.note}`,
        importance: 7,
        tags: ["background", "relationship"],
      };
    });
}
