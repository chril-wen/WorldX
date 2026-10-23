/**
 * expand-map.mjs
 * 地图区域扩展编排器
 *
 * 关键设计：旧地图是只读资产，永不被模型重绘。
 * 扩展流程：
 *   1. 读取现有 TMJ（已有 regions 坐标、collision grid）
 *   2. 从旧图提取视觉风格描述
 *   3. LLM 设计扩展方案（新区域内容 + 扩展方向）
 *   4. 独立生成新地图块（风格锚定）
 *   5. 接缝交叉融合 + 几何拼接成大地图
 *   6. 只解析新地图块内的 region 坐标
 *   7. 增量合并 TMJ（已有数据完全不动）
 *   8. 更新 world.json + 重建 main area points
 */

import dotenv from "dotenv";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");
dotenv.config({ path: join(ROOT, ".env") });

import { chatJSON } from "./models/llm-client.mjs";
import { generateImage } from "../../generators/map/src/models/gemini-flash-img.mjs";
import { geminiProVisionJSON } from "../../generators/map/src/models/gemini-pro.mjs";
import { normalizeExpandDesign } from "./world-design-utils.mjs";
import {
  extractStyleFromImage,
  formatStyleHint,
  analyzeEdgeContinuation,
  formatContinuationHint,
  generateMapTile,
  resizeTo,
} from "./map-tile-generator.mjs";
import { buildMainAreaPoints } from "./main-area-points.mjs";

/** 新地图块相对旧地图的扩展宽度（像素） */
const TILE_WIDTH = 640;
/** 扩展方向 */
const EXPAND_DIRECTION = "right";

export async function expandMap(worldDir, userPrompt) {
  const mapDir = join(worldDir, "map");
  const configDir = join(worldDir, "config");

  console.log("[ExpandMap] Starting map expansion...");
  console.log("[ExpandMap] World dir: " + worldDir);
  console.log("[ExpandMap] User prompt: " + userPrompt);

  // ── 1. 读取现有 TMJ ────────────────────────────────────────────────────────
  const tmjPath = join(mapDir, "06-final.tmj");
  if (!existsSync(tmjPath)) {
    throw new Error("TMJ not found at " + tmjPath);
  }
  const tmj = JSON.parse(readFileSync(tmjPath, "utf-8"));

  const regionsLayer = tmj.layers.find((l) => l.name === "regions");
  const objectsLayer = tmj.layers.find((l) => l.name === "interactive_objects");
  const collisionLayer = tmj.layers.find((l) => l.name === "collision");

  let existingRegions = (regionsLayer?.objects || []).map((obj) => ({
    id: obj.properties?.find((p) => p.name === "id")?.value || obj.name,
    name: obj.name,
    description: obj.properties?.find((p) => p.name === "description")?.value || "",
    type: obj.properties?.find((p) => p.name === "regionType")?.value || "",
    topLeft: { x: obj.x, y: obj.y },
    bottomRight: { x: obj.x + obj.width, y: obj.y + obj.height },
  }));

  const existingObjects = (objectsLayer?.objects || []).map((obj) => ({
    id: obj.properties?.find((p) => p.name === "objectId")?.value || obj.name,
    name: obj.name,
    topLeft: { x: obj.x, y: obj.y },
    bottomRight: { x: obj.x + obj.width, y: obj.y + obj.height },
  }));

  // ── 2. 读取 world.json ────────────────────────────────────────────────────
  const worldConfigPath = join(configDir, "world.json");
  if (!existsSync(worldConfigPath)) {
    throw new Error("world.json not found at " + worldConfigPath);
  }
  const worldConfig = JSON.parse(readFileSync(worldConfigPath, "utf-8"));

  // Fallback: TMJ 无 regions 时用 world.json 的 locations
  if (existingRegions.length === 0 && Array.isArray(worldConfig.locations)) {
    console.log("[ExpandMap] TMJ has no regions, falling back to world.json locations");
    existingRegions = worldConfig.locations.map((loc) => ({
      id: loc.id || loc.name,
      name: loc.name,
      description: loc.description || "",
      type: loc.type || "",
      topLeft: { x: 0, y: 0 },
      bottomRight: { x: 0, y: 0 },
    }));
  }

  console.log("[ExpandMap] Existing regions: " + existingRegions.length);
  for (const r of existingRegions) {
    console.log("  - " + r.name + " (" + r.id + ")");
  }

  // ── 3. 读取旧地图（只读资产） ─────────────────────────────────────────────
  const bgImagePath = join(mapDir, "06-background.png");
  if (!existsSync(bgImagePath)) {
    throw new Error("Background image not found at " + bgImagePath);
  }
  const originalMap = readFileSync(bgImagePath);
  const originalMeta = await import("sharp").then((m) => m.default(originalMap).metadata());
  const mapW = originalMeta.width;
  const mapH = originalMeta.height;
  console.log("[ExpandMap] Original map: " + mapW + "x" + mapH);

  // ── 4. 提取视觉风格（风格锚定） ───────────────────────────────────────────
  console.log("[ExpandMap] Extracting visual style from existing map...");
  const style = await extractStyleFromImage(originalMap, { geminiProVisionJSON });
  const styleHint = formatStyleHint(style);
  console.log("[ExpandMap] Style extracted: " + (style.artStyle || "(none)"));

  // ── 5. LLM 设计扩展方案 ────────────────────────────────────────────────────
  const expandPrompt = buildExpandPrompt({
    existingRegions,
    worldName: worldConfig.worldName,
    worldDescription: worldConfig.worldDescription,
    userPrompt,
  });

  console.log("[ExpandMap] Calling LLM for expansion design...");
  const rawResult = await chatJSON({
    systemMessage:
      "You are an expert world designer. ALWAYS return ONLY valid JSON with keys: newRegions, newInteractiveElements, mapDescription. newRegions must be an array of objects with: id, name, description, type, enterable, visualDescription.",
    userMessage: expandPrompt,
    temperature: 0.7,
    maxTokens: 8192,
    jsonRetries: 2,
  });

  const finalResult = normalizeLLMStructure(rawResult);
  if (!finalResult || !finalResult.newRegions) {
    throw new Error("LLM did not return valid expansion design");
  }

  const normalizedResult = normalizeExpandDesign({
    regions: finalResult.newRegions || [],
    interactiveElements: finalResult.newInteractiveElements || [],
  });

  const newRegions = normalizedResult.regions || [];
  const newObjects = normalizedResult.interactiveElements || [];

  console.log("[ExpandMap] LLM designed " + newRegions.length + " new regions");
  for (const r of newRegions) {
    console.log("  + " + r.name + " (" + r.id + ")");
  }
  if (newRegions.length === 0) {
    throw new Error("LLM returned no new regions to add");
  }

  // ── 6. 用 outpainting 生成新地图块 ─────────────────────────────────────────
  console.log("[ExpandMap] Analyzing edge continuation...");

  // 风格锚定只描述「画风」，不描述「边界上有什么正在穿过去」。
  // 要让新区看起来是同一个地方，必须额外分析旧图边缘：
  // 旧图右边缘如果有一条路延伸出画面，新区就得有同一条路接上。
  const edgeAnalysis = await analyzeEdgeContinuation(originalMap, EXPAND_DIRECTION, {
    geminiProVisionJSON,
  });
  const continuationHint = formatContinuationHint(edgeAnalysis);
  if (continuationHint) {
    console.log("[ExpandMap] Edge continuation hints: " + (edgeAnalysis.edgeCharacter || "(none)"));
  }

  console.log("[ExpandMap] Generating new map tile via outpainting...");
  const generated = await generateMapTile({
    referenceImage: originalMap,
    styleHint,
    continuationHint,
    contentPrompt: buildTileContentPrompt({
      newRegions,
      newObjects,
      userPrompt,
      worldName: worldConfig.worldName,
    }),
    side: EXPAND_DIRECTION,
    tileWidth: TILE_WIDTH,
    generateImage,
  });

  writeFileSync(join(mapDir, "06-background-expanded.png"), generated.canvas);
  writeFileSync(join(mapDir, "06-background-tile.png"), generated.tile);

  const newMeta = await sharpOf(generated.canvas);
  console.log(
    "[ExpandMap] Expanded map: " +
      originalMeta.width + "x" + originalMeta.height +
      " -> " + newMeta.width + "x" + newMeta.height,
  );

  // 备份旧地图，便于回滚
  const backupPath = join(mapDir, "06-background-base.png");
  if (!existsSync(backupPath)) {
    writeFileSync(backupPath, originalMap);
  }

  // 写入扩展后的大地图
  writeFileSync(bgImagePath, generated.canvas);

  // ── 7. 只解析新地图块内的 region 坐标 ─────────────────────────────────────
  console.log("[ExpandMap] Parsing new region coordinates (new tile only)...");
  const parsedNewRegions = await parseNewRegionCoordinates({
    tileBuffer: generated.tile,
    newRegions,
    newObjects,
    tileWidth: generated.tileWidth,
    tileHeight: generated.tileHeight,
    offsetX: generated.tileLeft,
    offsetY: generated.tileTop,
  });

  // ── 8. 增量合并 TMJ ───────────────────────────────────────────────────────
  console.log("[ExpandMap] Merging TMJ incrementally...");

  // 画布变宽后同步网格尺寸，旧区域碰撞数据原样搬运
  const newGridW = Math.round(newMeta.width / tmj.tilewidth);
  const newGridH = Math.round(newMeta.height / tmj.tileheight);
  if (newGridW !== tmj.width || newGridH !== tmj.height) {
    console.log(
      "[ExpandMap] Grid resized: " + tmj.width + "x" + tmj.height + " -> " + newGridW + "x" + newGridH,
    );
    resizeCollisionGrid(tmj, tmj.width, tmj.height, newGridW, newGridH);
    tmj.width = newGridW;
    tmj.height = newGridH;
    const bgLayer = tmj.layers.find((l) => l.name === "background");
    if (bgLayer) {
      bgLayer.imagewidth = newMeta.width;
      bgLayer.imageheight = newMeta.height;
    }
  }

  // 网格必须先扩容，再清碰撞——新区域的像素坐标落在旧网格之外
  const mergedTMJ = mergeTMJIncremental(tmj, parsedNewRegions, newObjects);

  writeFileSync(tmjPath, JSON.stringify(mergedTMJ, null, 2));
  console.log("[ExpandMap] Merged TMJ written to " + tmjPath);

  // ── 9. 更新 world.json ───────────────────────────────────────────────────
  console.log("[ExpandMap] Updating world.json...");
  const updatedWorldConfig = updateWorldConfig(
    worldConfig,
    newRegions,
    newObjects,
    parsedNewRegions.regions,
    parsedNewRegions.elements,
  );
  updatedWorldConfig.worldSize = {
    ...(updatedWorldConfig.worldSize || {}),
    width: newMeta.width,
    height: newMeta.height,
    tileSize: tmj.tilewidth,
    gridWidth: mergedTMJ.width,
    gridHeight: mergedTMJ.height,
  };

  // ── 10. rebuild main area points ─────────────────────────────────────────
  console.log("[ExpandMap] Rebuilding main area points...");
  updatedWorldConfig.mainAreaPoints = rebuildMainAreaPoints(mergedTMJ);
  writeFileSync(worldConfigPath, JSON.stringify(updatedWorldConfig, null, 2));
  console.log("[ExpandMap] world.json updated");

  console.log("[ExpandMap] Expansion complete!");
  return {
    newRegions: parsedNewRegions.regions.map((r) => ({ id: r.id, name: r.name })),
    newObjects: parsedNewRegions.elements.map((o) => ({ id: o.id, name: o.name })),
    mapDescription: finalResult.mapDescription || "",
    expandedSize: { width: newMeta.width, height: newMeta.height },
  };
}

async function sharpOf(buffer) {
  const sharp = (await import("sharp")).default;
  return sharp(buffer).metadata();
}

// ─── Prompt builders ────────────────────────────────────────────────────────

function buildExpandPrompt(opts) {
  const regionsList = opts.existingRegions
    .map((r) => "- " + r.name + "（" + r.id + "）: " + (r.description || r.type || "功能区"))
    .join("\n");

  return (
    '当前世界"' +
    opts.worldName +
    '"的地图需要扩展。\n\n' +
    "## 现有世界信息\n" +
    "- 世界名称：" +
    opts.worldName +
    "\n" +
    "- 世界描述：" +
    opts.worldDescription +
    "\n\n" +
    "## 已有区域（绝对不要重复生成）\n" +
    (regionsList || "（无）") +
    "\n\n" +
    "## 用户想添加的内容\n" +
    opts.userPrompt +
    "\n\n" +
    "请设计地图扩展方案。新增区域会出现在现有地图的【右侧】，作为全新的地块。\n\n" +
    "必须严格按照以下 JSON 格式返回（不要使用其他键名）：\n" +
    "{\n" +
    '  "mapDescription": "扩展后的完整地图描述",\n' +
    '  "newRegions": [\n' +
    "    {\n" +
    '      "id": "region_id",\n' +
    '      "name": "新区域名称",\n' +
    '      "description": "功能描述（一句话）",\n' +
    '      "type": "building",\n' +
    "      \"enterable\": true,\n" +
    '      "visualDescription": "俯视外观（一句话）"\n' +
    "    }\n" +
    "  ],\n" +
    '  "newInteractiveElements": []\n' +
    "}"
  );
}

function buildTileContentPrompt(opts) {
  const regionDesc = opts.newRegions
    .map((r) => "- " + r.name + "：" + (r.description || "") + "。" + (r.visualDescription || ""))
    .join("\n");
  const elementDesc = opts.newObjects
    .map((o) => "- " + o.name + "：" + (o.description || ""))
    .join("\n");

  return (
    "场景内容：\n" +
    regionDesc +
    (elementDesc ? "\n\n可交互元素：\n" + elementDesc : "") +
    "\n\n用户需求：" +
    opts.userPrompt +
    "\n\n世界：" +
    opts.worldName
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function normalizeLLMStructure(raw) {
  let result = raw;

  // Handle map_extension.new_areas structure
  if (!result?.newRegions && result?.map_extension?.new_areas) {
    result = {
      newRegions: result.map_extension.new_areas.map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description || "",
        type: a.type === "ruin" ? "outdoor" : a.type || "outdoor",
        enterable: a.enterable ?? false,
        visualDescription: a.visual_description || "",
      })),
      mapDescription: result.map_extension.extension_summary || "",
      newInteractiveElements: [],
    };
  }
  return result;
}

/**
 * 把视觉模型返回的坐标换算成整张地图的像素坐标。
 *
 * 分三步：
 *   1. 缩放：模型看到的是被缩小的图片（imgW×imgH），返回的坐标要乘回原尺寸
 *   2. 平移：加新区在完整画布中的偏移（offsetX/offsetY）
 *   3. 裁剪：限制在新区的范围内，防止模型返回越界坐标
 *
 * 抽成纯函数是为了让自检脚本能直接覆盖这条路径——之前它藏在一个
 * 需要真实调模型的函数里，缩放错误因此完全没被测出来。
 *
 * @param {object} box - { topLeft:{x,y}, bottomRight:{x,y} }，单位是模型所见图片的像素
 * @param {object} geom
 * @param {number} geom.imgW - 实际送进模型的图片宽度
 * @param {number} geom.imgH - 实际送进模型的图片高度
 * @param {number} geom.tileWidth - 新地块原始宽度（像素）
 * @param {number} geom.tileHeight - 新地块原始高度（像素）
 * @param {number} geom.offsetX - 新地块左边界在完整画布中的 x
 * @param {number} geom.offsetY - 新地块上边界在完整画布中的 y
 */
export function convertVisionBoxToGlobal(box, geom) {
  const { imgW, imgH, tileWidth, tileHeight, offsetX, offsetY } = geom;
  const scaleX = tileWidth / imgW;
  const scaleY = tileHeight / imgH;

  const tileMaxX = offsetX + tileWidth;
  const tileMaxY = offsetY + tileHeight;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  return {
    topLeft: {
      x: clamp(Math.round((box.topLeft?.x ?? 0) * scaleX) + offsetX, offsetX, tileMaxX),
      y: clamp(Math.round((box.topLeft?.y ?? 0) * scaleY) + offsetY, offsetY, tileMaxY),
    },
    bottomRight: {
      x: clamp(Math.round((box.bottomRight?.x ?? 0) * scaleX) + offsetX, offsetX, tileMaxX),
      y: clamp(Math.round((box.bottomRight?.y ?? 0) * scaleY) + offsetY, offsetY, tileMaxY),
    },
  };
}

/**
 * 构造「在图片上定位区域」的视觉提示词。
 *
 * 关键点：`imgW`/`imgH` 必须是【实际送进模型的图片尺寸】，而不是地块的
 * 原始尺寸。模型只会照着提示词里声明的尺寸返回坐标；如果声明的是
 * 640×1536 而实际送进去的是 320×768，模型返回的坐标就会比图片大一倍，
 * 换算时再乘一次缩放系数就成了两倍误差，region 框直接溢出画布。
 *
 * 抽成纯函数是为了让自检脚本能直接断言「声明尺寸 == 实际图片尺寸」。
 */
export function buildVisionCoordinatePrompt(opts) {
  const { imgW, imgH, regions, elements } = opts;
  const regionDesc = regions.map((r) => "- " + r.name + "：" + (r.description || "")).join("\n");
  const elementDesc = elements.map((o) => "- " + o.name + "：" + (o.description || "")).join("\n");

  return (
    "这是一张游戏俯视地图的一个【新地块】，尺寸：" +
    imgW +
    "×" +
    imgH +
    "像素。\n\n" +
    "## 需要定位的区域\n" +
    regionDesc +
    (elementDesc ? "\n\n## 需要定位的可交互元素\n" + elementDesc : "") +
    "\n\n请为每个区域和元素返回它们在这张图上的像素坐标（topLeft / bottomRight 为矩形包围盒）。\n" +
    "坐标相对于这张图的左上角 (0,0)。\n\n" +
    "返回 JSON：\n" +
    "{\n" +
    '  "newRegions": [\n' +
    '    { "id": "...", "name": "...", "topLeft": {"x":0,"y":0}, "bottomRight": {"x":0,"y":0} }\n' +
    "  ],\n" +
    '  "newElements": [\n' +
    '    { "id": "...", "name": "...", "topLeft": {"x":0,"y":0}, "bottomRight": {"x":0,"y":0} }\n' +
    "  ]\n" +
    "}"
  );
}

async function parseNewRegionCoordinates(opts) {
  const { tileBuffer, newRegions, newObjects, tileWidth, tileHeight, offsetX, offsetY } = opts;

  const small = await resizeTo(tileBuffer, 768);
  const smallMeta = await import("sharp").then((m) => m.default(small).metadata());
  // 实际送给视觉模型的图片尺寸（可能已被 resizeTo 缩小）
  const imgW = smallMeta.width || tileWidth;
  const imgH = smallMeta.height || tileHeight;

  const prompt = buildVisionCoordinatePrompt({
    imgW,
    imgH,
    regions: newRegions,
    elements: newObjects,
  });

  let result;
  try {
    result = await geminiProVisionJSON(prompt, [small], {
      requestTimeoutMs: 300000,
      timeoutEnvKey: "VISION_TIMEOUT_MS",
    });
  } catch (e) {
    console.warn("[ExpandMap] Vision parsing failed: " + e.message);
    result = null;
  }

  const parsedRegions = result?.newRegions || [];
  const parsedElements = result?.newElements || [];
  console.log(
    "[ExpandMap] Parsed " + parsedRegions.length + " regions, " + parsedElements.length + " elements",
  );

  // 坐标换算：缩放回原尺寸 + 加偏移量 + 裁剪到新区范围内
  // 裁剪是必需的：视觉模型偶尔会返回超出图片范围的坐标（例如把整条河流
  // 报成从 y=0 到 y=3072，而新区实际只有 1536 高）。不裁剪的话，
  // TMJ 里就会出现一个画布之外的 region——客户端渲染不出来，
  // 服务端的可达性判断也会跟着错。
  const geom = { imgW, imgH, tileWidth, tileHeight, offsetX, offsetY };
  const toGlobal = (box) => convertVisionBoxToGlobal(box, geom);

  const regions = reconcileDesignedItems(parsedRegions, newRegions, "region", toGlobal, {
    topLeft: { x: offsetX + 40, y: offsetY + 40 },
    bottomRight: { x: offsetX + tileWidth - 40, y: offsetY + tileHeight - 40 },
  });
  const elements = reconcileDesignedItems(parsedElements, newObjects, "element", toGlobal, {
    topLeft: { x: offsetX + 40, y: offsetY + 40 },
    bottomRight: { x: offsetX + tileWidth - 40, y: offsetY + tileHeight - 40 },
  });

  return { regions, elements };
}

/**
 * 把视觉模型返回的坐标与设计阶段的定义对齐。
 *
 * 视觉模型会自己改写 id（比如把 `ruined_pagoda` 写成 `pagoda-1`）。
 * 如果直接用它的 id，TMJ 里的 region id 就和 world.json 里的 location id 对不上：
 * 客户端从 TMJ 读区域、服务端从 world.json 读地点，两边看到的是不同的东西，
 * 于是新区域「看得见但用不了」。所以这里一律以设计阶段的 id 为准。
 *
 * @param {Array} parsedItems - 视觉模型返回的条目（含坐标）
 * @param {Array} designedItems - 设计阶段的定义（权威来源）
 * @param {string} label - 日志用
 * @param {(box: any) => any} toGlobal - 坐标换算函数
 * @param {{topLeft: any, bottomRight: any}} [placeholderBox] - 视觉漏掉时的兜底框
 */
export function reconcileDesignedItems(
  parsedItems,
  designedItems,
  label,
  toGlobal,
  placeholderBox,
) {
  const matched = new Set();

  const resolveDesigned = (parsedItem) => {
    const byId = designedItems.find((d) => d.id && d.id === parsedItem.id);
    if (byId) return byId;
    const byName = designedItems.find((d) => d.name && d.name === parsedItem.name);
    if (byName) return byName;
    // id 和 name 都对不上时，按顺序兜底到尚未匹配的设计条目
    const fallback = designedItems.find((d) => !matched.has(d.id));
    if (fallback) {
      console.warn(
        "[ExpandMap] Vision " + label + " id/name unmatched (" + (parsedItem.name || parsedItem.id) +
        "), falling back to designed: " + fallback.id,
      );
      return fallback;
    }
    return null;
  };

  const items = [];
  for (const p of parsedItems || []) {
    const designed = resolveDesigned(p);
    if (!designed) {
      console.warn("[ExpandMap] Vision returned an unknown " + label + ", skipped: " + (p.name || p.id));
      continue;
    }
    matched.add(designed.id);
    items.push({
      ...designed,
      name: designed.name,
      description: designed.description || "",
      type: designed.type || "outdoor",
      ...toGlobal(p),
    });
  }

  // 视觉漏掉的条目用占位框兜底，保证不会静默丢失
  for (const d of designedItems || []) {
    if (!items.find((x) => x.id === d.id)) {
      console.warn("[ExpandMap] " + label + " not located by vision, using placeholder: " + d.name);
      items.push({
        ...d,
        name: d.name,
        description: d.description || "",
        type: d.type || "outdoor",
        topLeft: placeholderBox?.topLeft ?? { x: 0, y: 0 },
        bottomRight: placeholderBox?.bottomRight ?? { x: 0, y: 0 },
      });
    }
  }

  return items;
}

// ─── TMJ merge ──────────────────────────────────────────────────────────────

export function mergeTMJIncremental(tmj, parsed, newObjects) {
  const regionsLayer = tmj.layers.find((l) => l.name === "regions");
  const objectsLayer = tmj.layers.find((l) => l.name === "interactive_objects");
  const collisionLayer = tmj.layers.find((l) => l.name === "collision");

  let maxId = 0;
  for (const layer of tmj.layers) {
    if (layer.objects) {
      for (const obj of layer.objects) {
        if (obj.id > maxId) maxId = obj.id;
      }
    }
  }

  // 追加新区域
  for (const r of parsed.regions) {
    maxId++;
    const obj = {
      id: maxId,
      name: r.name || r.id,
      type: "",
      x: r.topLeft?.x ?? 0,
      y: r.topLeft?.y ?? 0,
      width: Math.max(1, (r.bottomRight?.x ?? 0) - (r.topLeft?.x ?? 0)),
      height: Math.max(1, (r.bottomRight?.y ?? 0) - (r.topLeft?.y ?? 0)),
      rotation: 0,
      visible: true,
      properties: [
        { name: "id", type: "string", value: r.id || r.name },
        { name: "description", type: "string", value: r.description || "" },
        { name: "regionType", type: "string", value: r.type || "" },
        { name: "actions", type: "string", value: JSON.stringify(r.actions || []) },
        { name: "adjacentRegions", type: "string", value: JSON.stringify(r.adjacentRegions || []) },
      ],
    };
    if (regionsLayer?.objects) regionsLayer.objects.push(obj);
  }

  // 追加新物件
  for (const o of parsed.elements || []) {
    maxId++;
    const obj = {
      id: maxId,
      name: o.name || o.id,
      type: "",
      x: o.topLeft?.x ?? 0,
      y: o.topLeft?.y ?? 0,
      width: Math.max(1, (o.bottomRight?.x ?? 0) - (o.topLeft?.x ?? 0)),
      height: Math.max(1, (o.bottomRight?.y ?? 0) - (o.topLeft?.y ?? 0)),
      rotation: 0,
      visible: true,
      properties: [
        { name: "objectId", type: "string", value: o.id || o.name },
        { name: "interactions", type: "string", value: JSON.stringify(o.suggestedInteractions || []) },
      ],
    };
    if (objectsLayer?.objects) objectsLayer.objects.push(obj);
  }

  // 新区域默认可走：碰撞清零
  if (collisionLayer?.data) {
    const tileW = tmj.tilewidth;
    const tileH = tmj.tileheight;
    for (const region of parsed.regions) {
      const tl = region.topLeft;
      const br = region.bottomRight;
      if (!tl || !br) continue;
      const x1 = Math.floor(tl.x / tileW);
      const y1 = Math.floor(tl.y / tileH);
      const x2 = Math.ceil(br.x / tileW);
      const y2 = Math.ceil(br.y / tileH);
      for (let ty = y1; ty < y2; ty++) {
        for (let tx = x1; tx < x2; tx++) {
          if (ty >= 0 && ty < tmj.height && tx >= 0 && tx < tmj.width) {
            collisionLayer.data[ty * tmj.width + tx] = 0;
          }
        }
      }
    }
  }

  return tmj;
}

/** 画布变宽后，把碰撞层数据搬进新的网格，旧区域数据保持不变 */
export function resizeCollisionGrid(tmj, oldW, oldH, newW, newH) {
  const layer = tmj.layers.find((l) => l.name === "collision");
  if (!layer?.data) return;
  const oldData = layer.data;
  const newData = new Array(newW * newH).fill(1);
  for (let y = 0; y < Math.min(oldH, newH); y++) {
    for (let x = 0; x < Math.min(oldW, newW); x++) {
      newData[y * newW + x] = oldData[y * oldW + x];
    }
  }
  layer.data = newData;
  layer.width = newW;
  layer.height = newH;
}

// ─── World config ───────────────────────────────────────────────────────────

/**
 * 把新增区域写进 world.json 的 locations。
 *
 * 关键：location.id 必须与 TMJ 里 region 的 id 完全一致。
 * 客户端（MapManager）从 TMJ 读区域，服务端（WorldManager）从 world.json 读地点，
 * 两边 id 对不上就会出现「客户端看得见、服务端不知道」的区域。
 */
export function updateWorldConfig(worldConfig, newRegions, newObjects, parsedRegions, parsedElements) {
  const existingLocations = Array.isArray(worldConfig.locations) ? worldConfig.locations : [];
  const existingIds = new Set(existingLocations.map((l) => l.id));

  // 新区域内（或附近）的可交互物件归属到该区域
  const objectsByRegion = new Map();
  for (const obj of parsedElements || []) {
    const owner = (parsedRegions || []).find((r) =>
      obj.topLeft && r.topLeft &&
      obj.topLeft.x >= r.topLeft.x &&
      obj.topLeft.x <= r.bottomRight.x &&
      obj.topLeft.y >= r.topLeft.y &&
      obj.topLeft.y <= r.bottomRight.y,
    );
    if (!owner) continue;
    if (!objectsByRegion.has(owner.id)) objectsByRegion.set(owner.id, []);
    objectsByRegion.get(owner.id).push({
      id: obj.id,
      name: obj.name,
      locationId: owner.id,
      defaultState: "available",
      capacity: 1,
      interactions: Array.isArray(obj.suggestedInteractions)
        ? obj.suggestedInteractions.map((inter) => ({
            id: inter.id || inter.name?.toLowerCase().replace(/\s+/g, "_"),
            name: inter.name || inter.id,
            description: inter.description || "",
            availableWhenState: inter.availableWhenState || ["available"],
            duration: inter.duration || 2,
            effects: inter.effects || [{ type: "character_need", target: "curiosity", value: 5 }],
            repeatable: inter.repeatable ?? true,
          }))
        : [],
    });
  }

  const newLocations = newRegions
    .filter((r) => !existingIds.has(r.id))
    .map((r) => {
      const location = {
        id: r.id,
        name: r.name,
        description: r.description || "",
        adjacentLocations: ["main_area"],
        objects: objectsByRegion.get(r.id) || [],
      };
      if (r.indoor === true || r.indoor === false) {
        location.indoor = r.indoor;
      } else if (r.type) {
        location.indoor = r.type === "building";
      }
      return location;
    });

  worldConfig.locations = [...existingLocations, ...newLocations];
  return worldConfig;
}

// ─── Main area points ───────────────────────────────────────────────────────

/**
 * 用与建世界时相同的算法重建主区域点位。
 *
 * 必须复用 orchestrator/src/main-area-points.mjs 的 buildMainAreaPoints：
 *   - 它会做抽稀（prune）、命名、连通性检查（attachAdjacency）
 *   - 服务端依赖 adjacentPointIds 来判断「两个点位之间是否可达」，
 *     没有邻接关系的话角色会觉得哪儿也去不了
 *   - 服务端还依赖 name 字段做展示
 */
export function rebuildMainAreaPoints(tmj) {
  const collisionLayer = tmj.layers.find((l) => l.name === "collision");
  const regionsLayer = tmj.layers.find((l) => l.name === "regions");
  const objectsLayer = tmj.layers.find((l) => l.name === "interactive_objects");

  const tmjRegions = regionsLayer?.objects || [];
  const tmjObjects = objectsLayer?.objects || [];

  // 主区域点位要避开所有可交互区域（含主区域本身），否则角色会站在区域内部
  const points = buildMainAreaPoints({
    tmj,
    collisionLayer,
    regions: tmjRegions,
    elementObjects: tmjObjects,
  });

  console.log("[ExpandMap] Rebuilt " + points.length + " main area points");
  return points;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

if (process.argv[1]?.endsWith("expand-map.mjs")) {
  const worldDir = process.argv[2];
  const userPrompt = process.argv.slice(3).join(" ");

  if (!worldDir || !userPrompt) {
    console.error("Usage: node expand-map.mjs <worldDir> <userPrompt>");
    process.exit(1);
  }

  expandMap(worldDir, userPrompt)
    .then((result) => {
      console.log("\n[ExpandMap] Success!");
      console.log(JSON.stringify(result, null, 2));
      // 服务端用这一行解析结构化结果（见 server/src/api/routes/expand.ts）
      console.log("SUCCESS:" + JSON.stringify(result));
    })
    .catch((err) => {
      console.error("[ExpandMap] Error:", err.message);
      console.error(err.stack);
      console.error("ERROR:" + err.message);
      process.exit(1);
    });
}
