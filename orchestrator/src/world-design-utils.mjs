function clampDuration(value, fallback = 2) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.round(parsed));
}

function normalizeEffects(effects = [], fallbackNeed = "curiosity", fallbackDelta = 5) {
  if (!Array.isArray(effects) || effects.length === 0) {
    return [
      {
        type: "character_need",
        target: fallbackNeed,
        value: fallbackDelta,
      },
    ];
  }

  return effects.map((effect) => ({
    type: effect?.type || "character_need",
    target:
      effect?.target ||
      effect?.need ||
      effect?.key ||
      fallbackNeed,
    value:
      effect?.value !== undefined
        ? effect.value
        : effect?.delta !== undefined
          ? effect.delta
          : fallbackDelta,
  }));
}

function normalizeInteraction(interaction, fallbackId, fallbackName) {
  const id = interaction?.id || fallbackId;
  const result = {
    id,
    name: interaction?.name || fallbackName || id,
    description: interaction?.description || "",
    availableWhenState:
      Array.isArray(interaction?.availableWhenState) && interaction.availableWhenState.length > 0
        ? interaction.availableWhenState
        : ["available"],
    duration: clampDuration(interaction?.duration, 2),
    effects: normalizeEffects(interaction?.effects),
    repeatable: interaction?.repeatable ?? true,
  };
  if (interaction?.requiresAnchor === true) {
    result.requiresAnchor = true;
  }
  // Rich world: indoor/outdoor exposure and weather gating
  if (interaction?.exposure === "indoor" || interaction?.exposure === "outdoor") {
    result.exposure = interaction.exposure;
  }
  if (Array.isArray(interaction?.blockedWeather) && interaction.blockedWeather.length > 0) {
    result.blockedWeather = interaction.blockedWeather;
  }
  return result;
}

function inferRegionType(region) {
  if (region?.type === "building" || region?.type === "outdoor") {
    return region.type;
  }

  const haystack = `${region?.id || ""} ${region?.name || ""} ${region?.description || ""}`.toLowerCase();
  const outdoorKeywords = [
    "garden",
    "farm",
    "field",
    "plaza",
    "street",
    "market",
    "bridge",
    "pier",
    "dock",
    "yard",
    "river",
    "path",
    "road",
    "square",
    "广场",
    "街",
    "桥",
    "码头",
    "农田",
    "花园",
    "庭院",
    "摊",
  ];
  return outdoorKeywords.some((keyword) => haystack.includes(keyword))
    ? "outdoor"
    : "building";
}

function normalizeRegion(region, index) {
  const type = inferRegionType(region);
  const id = region?.id || `region_${index + 1}`;
  const name = region?.name || id;
  const enterable = region?.enterable ?? type === "building";
  const interactions = Array.isArray(region?.interactions)
    ? region.interactions.map((interaction, interactionIndex) =>
        normalizeInteraction(interaction, `${id}_action_${interactionIndex + 1}`, interaction?.name || `${name}行动`),
      )
    : [];

  const result = {
    id,
    name,
    description: region?.description || "",
    type,
    enterable,
    shapeConstraint:
      region?.shapeConstraint ||
      (enterable ? "rectangular" : "flexible"),
    placementHint: region?.placementHint || "",
    visualDescription: region?.visualDescription || "",
    expectedObjects: Array.isArray(region?.expectedObjects) ? region.expectedObjects : [],
    interactions,
  };
  if (region?.indoor === true || region?.indoor === false) {
    result.indoor = region.indoor;
  }
  return result;
}

function normalizeWorldAction(action, index) {
  const fallbackId = action?.id || `world_action_${index + 1}`;
  return {
    ...normalizeInteraction(action, fallbackId, action?.name || fallbackId),
    description: action?.description || "",
  };
}

function deriveLocationsFromRegions(regions) {
  return regions.map((region) => ({
    id: region.id,
    name: region.name,
    description: region.description,
    expectedObjects: region.expectedObjects || [],
    interactions: region.interactions || [],
  }));
}

function deriveMapPlan(mapPlan, regions) {
  const enterableCount = regions.filter((region) => region.enterable).length;
  const scenicCount = regions.filter((region) => !region.enterable && region.type === "building").length;

  let buildingMode = mapPlan?.buildingMode;
  if (!buildingMode) {
    if (regions.length === 0 || scenicCount > enterableCount) {
      buildingMode = "mostly_scenic";
    } else if (enterableCount > 0) {
      buildingMode = "mostly_enterable";
    } else {
      buildingMode = "mostly_scenic";
    }
  }

  return {
    buildingMode,
    compositionNotes: mapPlan?.compositionNotes || "",
    worldFunctionSummary: mapPlan?.worldFunctionSummary || "",
    regionDesignNotes: mapPlan?.regionDesignNotes || "",
  };
}

function normalizeInteractiveElement(element, index) {
  const id = element?.id || `element_${index + 1}`;
  const name = element?.name || id;
  const interactions = Array.isArray(element?.interactions)
    ? element.interactions.map((interaction, interactionIndex) =>
        normalizeInteraction(interaction, `${id}_action_${interactionIndex + 1}`, interaction?.name || `${name}互动`),
      )
    : [];

  const result = {
    id,
    name,
    description: element?.description || "",
    visualDescription: element?.visualDescription || "",
    placementHint: element?.placementHint || "",
    interactions,
  };
  if (element?.indoor === true || element?.indoor === false) {
    result.indoor = element.indoor;
  }
  return result;
}

function normalizeWorldSocialContext(value, fallback = "") {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function normalizeCharacterAnchor(anchor) {
  if (!anchor || typeof anchor !== "object") return undefined;
  const type = anchor.type;
  const targetId = anchor.targetId;
  if ((type === "region" || type === "element") && typeof targetId === "string" && targetId.length > 0) {
    return { type, targetId };
  }
  return undefined;
}

function parseTimeToMinutes(timeStr) {
  if (typeof timeStr !== "string") return 0;
  const [h, m] = timeStr.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return h * 60 + m;
}

function normalizeTimeConfig(rawTimeConfig, sceneType) {
  const tc = rawTimeConfig && typeof rawTimeConfig === "object" ? rawTimeConfig : {};
  const startTime = typeof tc.startTime === "string" && tc.startTime ? tc.startTime : "08:00";
  const displayFormat =
    tc.displayFormat === "ancient_chinese" || tc.displayFormat === "fantasy"
      ? tc.displayFormat
      : "modern";

  const TICK_DURATION = 15;
  let maxTicks = null;

  if (sceneType === "open") {
    if (typeof tc.endTime === "string" && tc.endTime) {
      const startMin = parseTimeToMinutes(startTime);
      const endMin = parseTimeToMinutes(tc.endTime);
      const diff = (endMin - startMin + 24 * 60) % (24 * 60);
      const windowMinutes = diff === 0 ? 24 * 60 : diff;
      maxTicks = Math.max(1, Math.round(windowMinutes / TICK_DURATION));
    } else if (typeof tc.maxTicks === "number" && Number.isFinite(tc.maxTicks)) {
      maxTicks = Math.max(1, Math.floor(tc.maxTicks));
    } else {
      maxTicks = Math.round((12 * 60) / TICK_DURATION);
    }
  }

  return { startTime, tickDurationMinutes: TICK_DURATION, maxTicks, displayFormat };
}

function normalizeMultiDayConfig(rawInput, sceneType, startTime) {
  const md = rawInput && typeof rawInput === "object" ? rawInput : {};
  const enabled = sceneType === "open";
  const endOfDayText = typeof md.endOfDayText === "string" ? md.endOfDayText : "";
  const newDayText = typeof md.newDayText === "string" ? md.newDayText : (typeof md.dayTransitionText === "string" ? md.dayTransitionText : "");
  const nextDayStartTime = sceneType === "open" ? startTime : "00:00";

  return { enabled, endOfDayText, newDayText, nextDayStartTime };
}

function normalizeEconomics(rawEconomics) {
  if (!rawEconomics || typeof rawEconomics !== "object") return null;
  const items = Array.isArray(rawEconomics.items)
    ? rawEconomics.items
        .filter((item) => item?.id && item?.name)
        .map((item) => ({
          id: String(item.id).trim(),
          name: String(item.name).trim(),
          initialStock: Math.max(0, Number(item.initialStock) || 0),
          consumptionPerUse: Math.max(1, Number(item.consumptionPerUse) || 1),
          restockAction: String(item.restockAction || "").trim() || undefined,
          restockAmount: Math.max(0, Number(item.restockAmount) || 0),
          displayStates: normalizeDisplayStates(item.displayStates),
          trackedBy: String(item.trackedBy || "").trim() || undefined,
        }))
    : [];
  if (items.length === 0) return null;
  return { items };
}

function normalizeDisplayStates(raw) {
  if (raw && typeof raw === "object") {
    const result = {};
    for (const [key, val] of Object.entries(raw)) {
      const n = Number(val);
      if (Number.isFinite(n)) result[String(key)] = n;
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }
  return undefined;
}

function normalizeRelationships(rawRelationships, characters) {
  if (!Array.isArray(rawRelationships) || rawRelationships.length === 0) return [];
  const charNames = new Set(characters.map((c) => c.name?.trim()).filter(Boolean));
  return rawRelationships
    .filter((rel) => {
      return charNames.has(String(rel.charA || "").trim()) && charNames.has(String(rel.charB || "").trim());
    })
    .map((rel) => ({
      charA: String(rel.charA).trim(),
      charB: String(rel.charB).trim(),
      affinity: Math.max(0, Math.min(5, Math.round(Number(rel.affinity) ?? 2))),
      tension: Math.max(0, Math.min(5, Math.round(Number(rel.tension) ?? 0))),
      note: String(rel.note || "").trim() || undefined,
    }));
}

function normalizeWeather(rawWeather) {
  if (!rawWeather || typeof rawWeather !== "object") return null;
  const preset = rawWeather.preset;
  const validPresets = ["temperate", "southern_water_town", "desert", "tropical", "tundra"];
  if (!validPresets.includes(preset)) return null;
  const result = { preset };
  if (typeof rawWeather.indoorDefault === "boolean") {
    result.indoorDefault = rawWeather.indoorDefault;
  }
  return result;
}

function normalizeHearsay(rawHearsay) {
  if (!rawHearsay || typeof rawHearsay !== "object") return { enabled: false };
  return { enabled: rawHearsay.enabled === true };
}

/**
 * 归一化世界规则 —— 设计流程或插件可以指定「这个世界怎么运转」。
 *
 * 只做**形状检查**，不做语义校验 —— 具体的规则名是否有效、
 * 值是否合理，交给 core 的 `mergeRules()` 和 `validateRawRules()`。
 *
 * **这里不依赖 core**（core 是 TS，orchestrator 是纯 .mjs，
 * 而且 `normalizeWorldDesign()` 有 6 个同步 importer，
 * 改成 async 会全部破）。语义校验在**写盘那一步**做 ——
 * 见 `config-generator.mjs` 的 `normalizeRulesForWrite()`。
 *
 * @param rawRules 原始规则段
 * @returns 规则段，或 null（没有就写 null，跟 economics/weather 一致）
 */
function normalizeRules(rawRules) {
  if (!rawRules || typeof rawRules !== "object" || Array.isArray(rawRules)) {
    return null;
  }
  return rawRules;
}

/**
 * 归一化世界设计 —— 把 LLM 返回的原始结构整理成内部统一形状。
 *
 * 注意 `export` 关键字：**2026-10-24 之前这里漏了 export**，
 * 导致 6 个 importer 全部起不来（ESM 的具名导出在导入时就检查），
 * 「创建世界」功能整个是坏的。6e16a7d 改这个文件时误删的。
 */
export function normalizeWorldDesign(rawDesign) {
  const rawRegions = Array.isArray(rawDesign?.regions)
    ? rawDesign.regions
    : Array.isArray(rawDesign?.locations)
      ? rawDesign.locations
      : [];
  const regions = rawRegions.map((region, index) => normalizeRegion(region, index));
  const worldActions = Array.isArray(rawDesign?.worldActions)
    ? rawDesign.worldActions.map((action, index) => normalizeWorldAction(action, index))
    : [];
  const interactiveElements = Array.isArray(rawDesign?.interactiveElements)
    ? rawDesign.interactiveElements.map((el, index) => normalizeInteractiveElement(el, index))
    : [];

  const characters = Array.isArray(rawDesign?.characters)
    ? rawDesign.characters.map((char) => ({
        ...char,
        anchor: normalizeCharacterAnchor(char?.anchor),
      }))
    : [];

  const locations = Array.isArray(rawDesign?.locations) && rawDesign.locations.length > 0
    ? rawDesign.locations.map((loc, index) => ({
        id: loc?.id || `location_${index + 1}`,
        name: loc?.name || loc?.id || `location_${index + 1}`,
        description: loc?.description || "",
        expectedObjects: Array.isArray(loc?.expectedObjects) ? loc.expectedObjects : [],
        interactions: Array.isArray(loc?.interactions)
          ? loc.interactions.map((interaction, interactionIndex) =>
              normalizeInteraction(
                interaction,
                `${loc?.id || `location_${index + 1}`}_action_${interactionIndex + 1}`,
                interaction?.name || "互动",
              ),
            )
          : [],
      }))
    : deriveLocationsFromRegions(regions);

  const sceneType = rawDesign?.sceneType === "open" ? "open" : "closed";
  const timeConfig = normalizeTimeConfig(rawDesign?.timeConfig, sceneType);
  const multiDay = normalizeMultiDayConfig(
    rawDesign?.sceneTransitionText || rawDesign?.multiDay,
    sceneType,
    timeConfig.startTime,
  );

  const economics = normalizeEconomics(rawDesign?.economics);
  const relationships = normalizeRelationships(rawDesign?.relationships, characters);
  const weather = normalizeWeather(rawDesign?.weather);
  const hearsay = normalizeHearsay(rawDesign?.hearsay);

  return {
    ...rawDesign,
    sceneType,
    timeConfig,
    multiDay,
    worldSocialContext: normalizeWorldSocialContext(
      rawDesign?.worldSocialContext,
      typeof rawDesign?.worldDescription === "string" ? rawDesign.worldDescription.trim() : "",
    ),
    regions,
    interactiveElements,
    characters,
    locations,
    worldActions,
    mapPlan: deriveMapPlan(rawDesign?.mapPlan, regions),
    economics,
    relationships,
    weather,
    hearsay,
    rules: normalizeRules(rawDesign?.rules),
  };
}

/**
 * Normalize the output of the expand-world LLM prompt.
 * Validates and normalizes new characters and locations, then returns them.
 */
export function normalizeExpandDesign(rawDesign) {
  const rawRegions = Array.isArray(rawDesign?.regions)
    ? rawDesign.regions
    : [];
  const rawInteractiveElements = Array.isArray(rawDesign?.interactiveElements)
    ? rawDesign.interactiveElements
    : [];

  // LLM 偶尔会把同一个区域返回两次——同一个名字配两个不同的 id
  // （实测「青竹林」同时给了 "qingzhulin" 和 "green_bamboo_grove"）。
  // 两个 id 都会进 world.json 和 TMJ，于是同一个地方在地图上有两个框，
  // 角色不知道该去哪个。这里按名字去重，保留第一个。
  const dedupeByName = (items) => {
    const seenNames = new Set();
    const seenIds = new Set();
    const out = [];
    for (const item of items) {
      const nameKey = String(item?.name ?? "").trim();
      const idKey = String(item?.id ?? "").trim();
      if (nameKey && seenNames.has(nameKey)) {
        console.warn(
          "[WorldDesign] Duplicate region name '" + nameKey + "' (id " + idKey + "), dropped",
        );
        continue;
      }
      if (idKey && seenIds.has(idKey)) {
        console.warn("[WorldDesign] Duplicate region id '" + idKey + "', dropped");
        continue;
      }
      if (nameKey) seenNames.add(nameKey);
      if (idKey) seenIds.add(idKey);
      out.push(item);
    }
    return out;
  };

  const regions = dedupeByName(rawRegions).map((region, index) => normalizeRegion(region, index));
  const interactiveElements = dedupeByName(rawInteractiveElements).map((el, index) =>
    normalizeInteractiveElement(el, index),
  );

  const characters = Array.isArray(rawDesign?.characters)
    ? rawDesign.characters.map((char) => ({
        ...char,
        anchor: normalizeCharacterAnchor(char?.anchor),
        skills: Array.isArray(char?.skills) ? char.skills : [],
        writeDiary: char?.writeDiary ?? false,
        fourthWallCandidate: char?.fourthWallCandidate ?? false,
        tags: Array.isArray(char?.tags) ? char.tags : [],
        extraversionLevel: Math.max(1, Math.min(5, Number(char?.extraversionLevel ?? 3))),
        intuitionLevel: Math.max(1, Math.min(5, Number(char?.intuitionLevel ?? 3))),
        socialStyle: normalizeSocialStyle(char?.socialStyle),
        coreValues: Array.isArray(char?.coreValues) ? char.coreValues : [],
        fears: Array.isArray(char?.fears) ? char.fears : [],
        initialMemories: Array.isArray(char?.initialMemories)
          ? char.initialMemories.map((m) => ({ type: "reflection", content: String(m) }))
          : [],
        name: String(char?.name || "").trim(),
        role: String(char?.role || "unknown").trim(),
        personality: String(char?.personality || "").trim(),
        appearance: String(char?.appearance || "").trim(),
        appearanceHint: String(char?.appearanceHint || "").trim(),
        motivation: String(char?.motivation || "").trim(),
        speakingStyle: String(char?.speakingStyle || "").trim(),
        coreMotivation: String(char?.coreMotivation || char?.motivation || "").trim(),
      }))
    : [];

  return {
    characters,
    regions,
    interactiveElements,
  };
}
