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
  EXPANSION_GEOMETRY,
} from "./map-tile-generator.mjs";
import { buildMainAreaPoints } from "./main-area-points.mjs";
import { pathToFileURL } from "url";

/**
 * 加载 core 的 TMJ 解析器 —— 全仓唯一的一份。
 *
 * 改造前 expand-map 自己写了一遍 `tmj.layers.find(...)`（6 处），
 * config-generator 写了一遍（3 处），core 写了一遍（2 处），
 * client 写了一遍（3 处）—— 共四份，靠「文件名 + 层名」两个字符串约定。
 *
 * ## 为什么用顶层 await
 *
 * `mergeTMJIncremental` / `resizeCollisionGrid` / `rebuildMainAreaPoints`
 * 是**导出的同步函数** —— 改成 async 会破坏 API，也破坏
 * `expand-map.selfcheck.test.ts` 的调用方式。
 *
 * ESM 的顶层 await 让模块加载时就把解析器拿到手，
 * 之后这三个同步函数就能直接调用 —— 不用改它们的签名。
 *
 * ## 为什么走 core 源码而不是 dist
 *
 * 跟 `config-generator.mjs` / `repair-world-locations.mjs` 一致：
 * 走 tsx 吃**源码**，跟 vitest、跟生成流程走的是同一份逻辑，
 * 不用先 build core，也不会用到旧的 dist。
 */
const { findTmjLayer } = await (async () => {
  const corePath = join(
    __dirname,
    "..",
    "..",
    "packages",
    "core",
    "src",
    "engine",
    "tmj-parser.ts",
  );
  try {
    const { tsImport } = await import("tsx/esm/api");
    return await tsImport(pathToFileURL(corePath).href, import.meta.url);
  } catch (err) {
    throw new Error(
      `[ExpandMap] 加载 core 的 TMJ 解析器失败（${corePath}）：${err?.message ?? err}`,
    );
  }
})();

/** 新地图块在扩展方向上的厚度（像素） */
const TILE_EXTENT = 640;

/**
 * 把 Tiled 对象的 properties 摊平成普通对象。
 *
 * 改造前这里有 4 处一模一样的 `(obj.properties || []).find((p) => p.name === "x")?.value`
 * —— 每次都要重新遍历一遍数组。
 *
 * **兜底规则保持原样**（`|| obj.name` 之类）——
 * 生成期要尽量不丢数据，跟 client 的「没有 id 就跳过」不同。
 * 那种差异是**有意义的**，所以不改。
 */
function getTmjObjectProperties(obj) {
  const props = {};
  for (const p of obj?.properties || []) {
    props[p.name] = p.value;
  }
  return props;
}

/**
 * 扩展方向。
 *
 * 之前固定为 "right"，所以地图永远只能横向生长成一条长条。
 * 现在支持 4 个方向：用户可以指定，不指定时由 LLM 根据地图内容自动判断
 * （见 chooseExpansionSide）。
 */
export const EXPANSION_SIDES = ["right", "left", "bottom", "top"];

export async function expandMap(worldDir, userPrompt, options = {}) {
  const mapDir = join(worldDir, "map");
  const configDir = join(worldDir, "config");
  // 用户指定的扩展方向；"auto" 表示交给 LLM 判断
  const requestedSide = options.side && options.side !== "auto" ? options.side : null;

  console.log("[ExpandMap] Starting map expansion...");
  console.log("[ExpandMap] World dir: " + worldDir);
  console.log("[ExpandMap] User prompt: " + userPrompt);
  console.log("[ExpandMap] Requested side: " + (requestedSide ?? "auto"));

  // ── 1. 读取现有 TMJ ────────────────────────────────────────────────────────
  const tmjPath = join(mapDir, "06-final.tmj");
  if (!existsSync(tmjPath)) {
    throw new Error("TMJ not found at " + tmjPath);
  }
  const tmj = JSON.parse(readFileSync(tmjPath, "utf-8"));

  const regionsLayer = findTmjLayer(tmj, "regions");
  const objectsLayer = findTmjLayer(tmj, "interactive_objects");
  const collisionLayer = findTmjLayer(tmj, "collision");

  let existingRegions = (regionsLayer?.objects || []).map((obj) => {
    const props = getTmjObjectProperties(obj);
    return {
      id: props.id || obj.name,
      name: obj.name,
      description: props.description || "",
      type: props.regionType || "",
      topLeft: { x: obj.x, y: obj.y },
      bottomRight: { x: obj.x + obj.width, y: obj.y + obj.height },
    };
  });

  const existingObjects = (objectsLayer?.objects || []).map((obj) => {
    const props = getTmjObjectProperties(obj);
    return {
      id: props.objectId || obj.name,
      name: obj.name,
      topLeft: { x: obj.x, y: obj.y },
      bottomRight: { x: obj.x + obj.width, y: obj.y + obj.height },
    };
  });

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

  // ── 5. 决定扩展方向 ────────────────────────────────────────────────────────
  //
  // 用户指定了就用它；没指定就分析地图的四个边缘，让 LLM 挑一个最合适的。
  // 挑边的依据是「哪条边缘看起来还没画完、可以往外接」——
  // 比如边缘上有一条路正好断在边界外，说明那边还没铺完。
  let expandSide = requestedSide;
  if (!expandSide) {
    console.log("[ExpandMap] Auto-selecting expansion side...");
    try {
      expandSide = await chooseExpansionSide(originalMap, {
        existingRegions,
        userPrompt,
        geminiProVisionJSON,
      });
    } catch (e) {
      console.warn("[ExpandMap] Side selection failed (" + e.message + "), falling back to right");
      expandSide = "right";
    }
  }
  if (!EXPANSION_SIDES.includes(expandSide)) {
    throw new Error(`Invalid expansion side: ${expandSide}`);
  }
  const sideGeom = EXPANSION_GEOMETRY[expandSide];
  console.log("[ExpandMap] Expanding " + sideGeom.directionLabel);

  // ── 6. LLM 设计扩展方案 ────────────────────────────────────────────────────
  const expandPrompt = buildExpandPrompt({
    existingRegions,
    worldName: worldConfig.worldName,
    worldDescription: worldConfig.worldDescription,
    userPrompt,
    side: expandSide,
    directionLabel: sideGeom.directionLabel,
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

  // ── 7. 用 outpainting 生成新地图块 ─────────────────────────────────────────
  console.log("[ExpandMap] Analyzing edge continuation...");

  // 风格锚定只描述「画风」，不描述「边界上有什么正在穿过去」。
  // 要让新区看起来是同一个地方，必须额外分析旧图边缘：
  // 旧图右边缘如果有一条路延伸出画面，新区就得有同一条路接上。
  const edgeAnalysis = await analyzeEdgeContinuation(originalMap, expandSide, {
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
    side: expandSide,
    extent: TILE_EXTENT,
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
    // 旧网格在完整地图里的偏移：向左扩要右移，向上扩要下移
    const gridOffsetX = expandSide === "left" ? newGridW - tmj.width : 0;
    const gridOffsetY = expandSide === "top" ? newGridH - tmj.height : 0;
    resizeCollisionGrid(
      tmj,
      tmj.width,
      tmj.height,
      newGridW,
      newGridH,
      gridOffsetX,
      gridOffsetY,
    );
    tmj.width = newGridW;
    tmj.height = newGridH;
    const bgLayer = findTmjLayer(tmj, "background");
    if (bgLayer) {
      bgLayer.imagewidth = newMeta.width;
      bgLayer.imageheight = newMeta.height;
    }
  }

  // 网格必须先扩容，再清碰撞——新区域的像素坐标落在旧网格之外
  //
  // 向左/向上扩展时旧图在画布里整体右移/下移，旧 region 与物件的像素坐标
  // 也要跟着平移，否则它们会标注到新区的位置上。
  const shiftX = expandSide === "left" ? newMeta.width - originalMeta.width : 0;
  const shiftY = expandSide === "top" ? newMeta.height - originalMeta.height : 0;
  const mergeResult = mergeTMJIncremental(tmj, parsedNewRegions, newObjects, shiftX, shiftY);
  const mergedTMJ = mergeResult.tmj;

  writeFileSync(tmjPath, JSON.stringify(mergedTMJ, null, 2));
  console.log("[ExpandMap] Merged TMJ written to " + tmjPath);

  // ── 9. 更新 world.json ───────────────────────────────────────────────────
  console.log("[ExpandMap] Updating world.json...");
  // 只写真正进了 TMJ 的区域——被去重跳过的区域不该在 world.json 里
  // 留一个没有对应框的地点（那种地点在地图上点不到，角色也走不到）。
  const updatedWorldConfig = updateWorldConfig(
    worldConfig,
    newRegions,
    newObjects,
    mergeResult.acceptedRegions,
    mergeResult.acceptedElements,
    mergeResult.acceptedRegions.map((r) => r.id),
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

  const directionLabel = opts.directionLabel || "向右";

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
    "请设计地图扩展方案。新增区域会出现在现有地图的【" +
    directionLabel +
    "】，作为全新的地块。\n\n" +
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

/**
 * 自动选择扩展方向。
 *
 * 把地图的四条边缘各截一条，拼成一张「十字」对照图交给视觉模型，
 * 让它挑一条最自然的边——通常是那条看起来「还没画完」、有道路或水系
 * 正好断在边界上的边。
 *
 * 比四次单独调用便宜，也比让它凭空猜更准。
 */
async function chooseExpansionSide(mapBuffer, { existingRegions, userPrompt, geminiProVisionJSON }) {
  const sharp = (await import("sharp")).default;
  const meta = await sharp(mapBuffer).metadata();
  const W = meta.width;
  const H = meta.height;

  const STRIP = 180;
  const sw = Math.min(STRIP, W);
  const sh = Math.min(STRIP, H);

  // 四条边缘条带，统一缩放到 256 长边
  const strips = {
    top: await sharp(mapBuffer)
      .extract({ left: 0, top: 0, width: W, height: sh })
      .resize({ width: 256, height: 256, fit: "inside" })
      .toBuffer(),
    bottom: await sharp(mapBuffer)
      .extract({ left: 0, top: H - sh, width: W, height: sh })
      .resize({ width: 256, height: 256, fit: "inside" })
      .toBuffer(),
    left: await sharp(mapBuffer)
      .extract({ left: 0, top: 0, width: sw, height: H })
      .resize({ width: 256, height: 256, fit: "inside" })
      .toBuffer(),
    right: await sharp(mapBuffer)
      .extract({ left: W - sw, top: 0, width: sw, height: H })
      .resize({ width: 256, height: 256, fit: "inside" })
      .toBuffer(),
  };

  // 拼成 2x2 对照图：左上=上，右上=下，左下=左，右下=右
  const cell = 256;
  const collage = await sharp({
    create: { width: cell * 2, height: cell * 2, channels: 3, background: { r: 20, g: 20, b: 20 } },
  })
    .composite([
      { input: strips.top, left: 0, top: 0 },
      { input: strips.bottom, left: cell, top: 0 },
      { input: strips.left, left: 0, top: cell },
      { input: strips.right, left: cell, top: cell },
    ])
    .png()
    .toBuffer();

  const regionNames = (existingRegions || []).map((r) => r.name).join("、") || "（无）";

  const prompt =
    "这是一张游戏俯视地图的四条边缘，按 2x2 拼在一张图里：\n" +
    "  左上 = 地图的上边缘（north）\n" +
    "  右上 = 地图的下边缘（south）\n" +
    "  左下 = 地图的左边缘（west）\n" +
    "  右下 = 地图的右边缘（east）\n\n" +
    "用户想在这个地图上添加内容：" + userPrompt + "\n" +
    "地图上已有的区域：" + regionNames + "\n\n" +
    "请挑一条【最适合向外扩展】的边缘。判断依据：\n" +
    "- 那条边缘上是否有空间元素（道路/河道/建筑/围墙）正好延伸到边界外，像是还没画完\n" +
    "- 哪条边界的空白更多、更适合放新内容\n" +
    "- 要和用户想添加的内容类型相符\n\n" +
    '返回一个 JSON：{"side": "right|left|top|bottom", "reason": "一句话说明为什么选这条边"}';

  const result = await geminiProVisionJSON(prompt, [collage]);
  const side = result?.side;
  if (!EXPANSION_SIDES.includes(side)) {
    console.warn("[ExpandMap] LLM returned invalid side: " + side + ", falling back to right");
    return "right";
  }
  console.log("[ExpandMap] Auto-selected side: " + side + " (" + (result.reason || "") + ")");
  return side;
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
  // id 必须原样交给模型，让它回填。
  // 之前只给了 name/description，模型只能自己编 id——它会把中文名音译成
  // "qingzhulin" 这种拼音，而设计阶段的 id 是 "green_bamboo_grove"，
  // 两者对不上，坐标就被整体丢弃、退化成占位框。
  const regionDesc = regions
    .map((r) => '- id="' + (r.id || "") + '" 名称：' + r.name + "：" + (r.description || ""))
    .join("\n");
  const elementDesc = elements
    .map((o) => '- id="' + (o.id || "") + '" 名称：' + o.name + "：" + (o.description || ""))
    .join("\n");
  // 分块解析时，同一批区域会在每一块里被问一遍。只在当前块里出现的
  // 才返回坐标，不在的必须跳过——否则同一个区域会在多块里各返回一次，
  // 坐标还互相冲突。
  const sliceNote = opts.sliceNote
    ? "\n\n**重要**：这张图只是新地块的一部分。如果某个区域/元素并没有出现在这张图里" +
      "（画面中完全看不到），不要返回它的坐标，直接跳过它。"
    : "";

  return (
    "这是一张游戏俯视地图的一个【新地块】，尺寸：" +
    imgW +
    "×" +
    imgH +
    "像素。\n\n" +
    "## 需要定位的区域\n" +
    regionDesc +
    (elementDesc ? "\n\n## 需要定位的可交互元素\n" + elementDesc : "") +
    sliceNote +
    "\n\n请为每个区域和元素返回它们在这张图上的像素坐标（topLeft / bottomRight 为矩形包围盒）。\n" +
    "坐标相对于这张图的左上角 (0,0)。\n" +
    "**返回的 id 必须原样使用上面给出的 id，不要翻译、不要改写、不要自己编。**\n\n" +
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

/**
 * 把新区切成若干块，让视觉模型分块定位。
 *
 * 为什么需要分块：视觉坐标解析要把图缩到 768px 长边再送模型。
 * 横向扩展时新区是 640x720（接近方形），缩完还剩 640x720，定位很准。
 * 但垂直扩展时新区是 3200x640 的长条——缩完只剩 768x154，宽高比 5:1，
 * 视觉模型在这种比例下会退化，把整个新区当成一个区域返回
 * （实测三个区域共用同一个框）。
 *
 * 切成接近方形的块之后，每块的比例正常，定位精度回来了。
 */
export function planTileSlices(tileWidth, tileHeight, maxDim = 768) {
  // 目标：每块缩到 maxDim 后仍接近方形
  const aspect = tileWidth / tileHeight;

  // 已经是合理比例就不用切
  if (aspect >= 0.5 && aspect <= 2) {
    return [{ left: 0, top: 0, width: tileWidth, height: tileHeight }];
  }

  const slices = [];
  if (aspect > 2) {
    // 太宽：按宽度切。
    //
    // 块宽取「高度×1.8」而不是更小——块数直接决定视觉调用次数，而每次
    // 调用都可能撞上网关的 240s 超时再重试一遍。3200x640 切成 3 块
    // （每块 1067x640，比例 1.67）已经落在模型不退化的区间里，
    // 比切成 5 块省掉两次往返。
    const targetW = Math.max(1, Math.round(tileHeight * 1.8));
    const count = Math.ceil(tileWidth / targetW);
    // 重新分配宽度，让每块尽量等宽（余量摊给前面的块）
    const baseW = Math.floor(tileWidth / count);
    const remainder = tileWidth % count;
    let left = 0;
    for (let i = 0; i < count; i++) {
      const width = baseW + (i < remainder ? 1 : 0);
      slices.push({ left, top: 0, width, height: tileHeight });
      left += width;
    }
  } else {
    // 太高：按高度切，逻辑对称
    const targetH = Math.max(1, Math.round(tileWidth / 1.8));
    const count = Math.ceil(tileHeight / targetH);
    const baseH = Math.floor(tileHeight / count);
    const remainder = tileHeight % count;
    let top = 0;
    for (let i = 0; i < count; i++) {
      const height = baseH + (i < remainder ? 1 : 0);
      slices.push({ left: 0, top, width: tileWidth, height });
      top += height;
    }
  }
  return slices;
}

async function parseNewRegionCoordinates(opts) {
  const { tileBuffer, newRegions, newObjects, tileWidth, tileHeight, offsetX, offsetY } = opts;

  const sharp = (await import("sharp")).default;

  // 长条形新区切成多块分别定位
  const slices = planTileSlices(tileWidth, tileHeight);
  if (slices.length > 1) {
    console.log(
      "[ExpandMap] Tile is " + tileWidth + "x" + tileHeight +
        " (aspect " + (tileWidth / tileHeight).toFixed(1) + "), splitting into " +
        slices.length + " slices for vision",
    );
  }

  const parsedRegions = [];
  const parsedElements = [];

  for (let i = 0; i < slices.length; i++) {
    const slice = slices[i];
    const sliceBuffer = await sharp(tileBuffer)
      .extract({ left: slice.left, top: slice.top, width: slice.width, height: slice.height })
      .png()
      .toBuffer();

    const small = await resizeTo(sliceBuffer, 768);
    const smallMeta = await sharp(small).metadata();
    // 实际送给视觉模型的图片尺寸（可能已被 resizeTo 缩小）
    const imgW = smallMeta.width || slice.width;
    const imgH = smallMeta.height || slice.height;

    // 这一块在新区里的原始坐标原点
    const sliceOriginX = slice.left;
    const sliceOriginY = slice.top;

    const prompt = buildVisionCoordinatePrompt({
      imgW,
      imgH,
      regions: newRegions,
      elements: newObjects,
      sliceNote: slices.length > 1,
    });

    let result = null;
    try {
      result = await geminiProVisionJSON(prompt, [small], {
        requestTimeoutMs: 300000,
        timeoutEnvKey: "VISION_TIMEOUT_MS",
      });
    } catch (e) {
      console.warn("[ExpandMap] Vision parsing failed on slice " + (i + 1) + ": " + e.message);
    }

    if (!result) continue;

    // 调试：打印视觉模型的原始返回，看它到底给了什么坐标
    if (process.env.EXPAND_DEBUG_VISION) {
      console.log(
        "[ExpandMap][debug] slice " + (i + 1) + " img=" + imgW + "x" + imgH +
          " raw=" + JSON.stringify(result.newRegions),
      );
    }

    // 块内坐标 -> 新区坐标 -> 全局坐标
    const geom = {
      imgW,
      imgH,
      tileWidth: slice.width,
      tileHeight: slice.height,
      offsetX: offsetX + sliceOriginX,
      offsetY: offsetY + sliceOriginY,
    };
    const toGlobal = (box) => convertVisionBoxToGlobal(box, geom);

    for (const r of result.newRegions || []) {
      // toGlobal 接收的是【整个框】（内部读 box.topLeft / box.bottomRight），
      // 不能只传 r.topLeft —— 那样框会塌缩成一个点，面积变成 0。
      parsedRegions.push({ ...r, ...toGlobal(r) });
    }
    for (const e of result.newElements || []) {
      parsedElements.push({ ...e, ...toGlobal(e) });
    }

    console.log(
      "[ExpandMap] Slice " + (i + 1) + "/" + slices.length +
        " parsed " + ((result.newRegions || []).length) + " regions, " +
        ((result.newElements || []).length) + " elements",
    );
  }

  console.log(
    "[ExpandMap] Parsed " + parsedRegions.length + " regions, " + parsedElements.length + " elements",
  );

  // ── 坐标换算已完成（上面已换算成全局坐标），这里做设计阶段的对齐与兜底。
  //
  // 两阶段匹配：先按 id、再按名字精确匹配（跨所有块统一做），
  // 剩下的才按顺序配对。顺序配对必须放在统一层面——
  // 如果每块各自兜底，块 1 的陌生条目会抢走本该属于块 3 的区域。
  // 兜底框：把新区横向均分成若干格，视觉漏掉的区域各占一格。
  // 之前所有兜底项共用一个大框，于是它们叠在一起变成一个覆盖整片
  // 新区的怪框——地图上看不出这是两个地方。
  const makePlaceholder = (count) => {
    const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
    const rows = Math.max(1, Math.ceil(count / cols));
    const cellW = tileWidth / cols;
    const cellH = tileHeight / rows;
    return (d, index) => {
      const c = index % cols;
      const r = Math.floor(index / cols);
      return {
        topLeft: { x: offsetX + Math.round(c * cellW) + 40, y: offsetY + Math.round(r * cellH) + 40 },
        bottomRight: {
          x: offsetX + Math.round((c + 1) * cellW) - 40,
          y: offsetY + Math.round((r + 1) * cellH) - 40,
        },
      };
    };
  };

  const regions = reconcileDesignedItems(
    parsedRegions,
    newRegions,
    "region",
    (b) => b,
    makePlaceholder(newRegions.length),
  );
  const elements = reconcileDesignedItems(
    parsedElements,
    newObjects,
    "element",
    (b) => b,
    makePlaceholder(newObjects.length),
  );

  return { regions, elements };
}

/**
 * 把名字规范化，用于跨 id 的模糊匹配。
 * 去掉空白、标点、下划线，转小写——这样 "Green Bamboo Grove"、
 * "green_bamboo_grove"、"green-bamboo-grove" 会归一到同一个 key。
 */
function normalizeKey(name) {
  if (!name || typeof name !== "string") return "";
  return name
    .toLowerCase()
    .replace(/[\s_\-·・、，,。.]/g, "")
    .trim();
}

/**
 * 矩形框的面积。用来在多个候选坐标里挑「最像样」的那个——
 * 模型在看不见该区域的块里会给出 0,0->1,1 这种退化框，面积接近 0。
 */
function boxArea(box) {
  const w = (box?.bottomRight?.x ?? 0) - (box?.topLeft?.x ?? 0);
  const h = (box?.bottomRight?.y ?? 0) - (box?.topLeft?.y ?? 0);
  return Math.max(0, w) * Math.max(0, h);
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
  opts = {},
) {
  const matched = new Set();
  const allowOrderFallback = opts.allowOrderFallback !== false;

  // 只从 toGlobal 的返回值里取坐标字段。
  // 不能把整个返回值展开进 item——toGlobal 收到的是视觉返回的原始对象，
  // 展开它会把模型自己编的 id 覆盖到设计阶段的 id 上，
  // 于是 TMJ 里的 region id 和 world.json 里的 location id 对不上，
  // 区域「看得见但用不了」。
  const coordOf = (p) => {
    const g = toGlobal(p) || {};
    return { topLeft: g.topLeft, bottomRight: g.bottomRight };
  };

  // ── 第一阶段：精确匹配（按 id → 按名字 → 按规范化名字）────────────────────
  const resolveExact = (parsedItem) => {
    const byId = designedItems.find((d) => d.id && d.id === parsedItem.id);
    if (byId) return byId;
    const byName = designedItems.find((d) => d.name && d.name === parsedItem.name);
    if (byName) return byName;
    // id 对不上但名字对得上（模型把 id 音译了，或大小写/连字符不同）
    const normName = normalizeKey(parsedItem.name);
    if (normName) {
      const byNormName = designedItems.find((d) => normalizeKey(d.name) === normName);
      if (byNormName) {
        console.warn(
          "[ExpandMap] Vision " + label + " id mismatch (" + parsedItem.id +
            "), matched by name: " + byNormName.id,
        );
        return byNormName;
      }
    }
    return null;
  };

  const items = [];
  const unmatched = [];

  // 同一个设计项可能在多个块里被返回（模型在看不见它的那块里也会给一个
  // 退化坐标 0,0->1,1）。收集所有候选，最后挑最像样的那个——
  // 取「第一个」会选中退化框，因为第一块往往正好不含该区域。
  const candidates = new Map(); // designed.id -> [{ parsed, area }]

  for (const p of parsedItems || []) {
    const designed = resolveExact(p);
    if (!designed) {
      unmatched.push(p);
      continue;
    }
    const box = coordOf(p);
    const area = boxArea(box);
    if (!candidates.has(designed.id)) candidates.set(designed.id, []);
    candidates.get(designed.id).push({ designed, box, area });
  }

  for (const [designedId, list] of candidates) {
    // 退化框（面积 0 或极小）排最后
    const best = list
      .slice()
      .sort((a, b) => {
        const aBad = a.area <= 1 ? 1 : 0;
        const bBad = b.area <= 1 ? 1 : 0;
        if (aBad !== bBad) return aBad - bBad;
        return b.area - a.area;
      })[0];

    if (list.length > 1) {
      console.log(
        "[ExpandMap] " + label + " '" + best.designed.name + "' located in " +
          list.length + " candidates, picked area " + Math.round(best.area),
      );
    }
    matched.add(designedId);
    items.push({
      ...best.designed,
      name: best.designed.name,
      description: best.designed.description || "",
      type: best.designed.type || "outdoor",
      topLeft: best.box.topLeft,
      bottomRight: best.box.bottomRight,
    });
  }

  // ── 第二阶段：剩下的按顺序配对 ────────────────────────────────────────────
  //
  // 精确匹配全做完之后才做顺序兜底：如果每块各自兜底，块 1 的陌生条目
  // 会抢走本该属于块 3 的区域。现在顺序兜底只在统一层面发生。
  if (unmatched.length > 0 && allowOrderFallback) {
    const remaining = (designedItems || []).filter((d) => !matched.has(d.id));
    for (let i = 0; i < unmatched.length; i++) {
      const p = unmatched[i];
      const designed = remaining[i];
      if (!designed) {
        console.warn(
          "[ExpandMap] Vision returned an unknown " + label + ", skipped: " + (p.name || p.id),
        );
        continue;
      }
      console.warn(
        "[ExpandMap] Vision " + label + " id/name unmatched (" + (p.name || p.id) +
          "), paired by order with: " + designed.id,
      );
      matched.add(designed.id);
      items.push({
        ...designed,
        name: designed.name,
        description: designed.description || "",
        type: designed.type || "outdoor",
        ...coordOf(p),
      });
    }
  } else {
    for (const p of unmatched) {
      console.warn(
        "[ExpandMap] Vision returned an unknown " + label + ", skipped: " + (p.name || p.id),
      );
    }
  }

  // 视觉漏掉的条目用占位框兜底，保证不会静默丢失。
  // 占位框按新区切成格子依次分配——如果所有兜底项共用一个大框，
  // 它们会叠在一起，地图上看起来就是一个覆盖整片新区的怪框。
  for (const d of designedItems || []) {
    if (!items.find((x) => x.id === d.id)) {
      console.warn("[ExpandMap] " + label + " not located by vision, using placeholder: " + d.name);
      const ph =
        typeof placeholderBox === "function"
          ? placeholderBox(d, designedItems.indexOf(d))
          : placeholderBox;
      items.push({
        ...d,
        name: d.name,
        description: d.description || "",
        type: d.type || "outdoor",
        topLeft: ph?.topLeft ?? { x: 0, y: 0 },
        bottomRight: ph?.bottomRight ?? { x: 0, y: 0 },
      });
    }
  }

  return items;
}

// ─── TMJ merge ──────────────────────────────────────────────────────────────

/**
 * 增量合并 TMJ：追加新区域/物件，并按扩展方向平移旧对象。
 *
 * 向左/向上扩展时，新区插在旧图的前面，旧图在完整画布里的位置就变了
 * （整体右移或下移）。旧 region / interactive_object 的像素坐标必须跟着平移，
 * 否则它们会标注到新区的位置上——客户端会显示错位的区域框。
 *
 * @param {object} tmj - TMJ 对象（原地修改）
 * @param {object} parsed - { regions: [...], elements: [...] }，已是全局坐标
 * @param {object[]} newObjects - 设计阶段的新物件
 * @param {number} shiftX - 旧对象要平移的 x 像素（向左扩展时为正）
 * @param {number} shiftY - 旧对象要平移的 y 像素（向上扩展时为正）
 */
export function mergeTMJIncremental(tmj, parsed, newObjects, shiftX = 0, shiftY = 0) {
  const regionsLayer = findTmjLayer(tmj, "regions");
  const objectsLayer = findTmjLayer(tmj, "interactive_objects");
  const collisionLayer = findTmjLayer(tmj, "collision");

  // ── 平移旧对象 ─────────────────────────────────────────────────────────────
  if (shiftX !== 0 || shiftY !== 0) {
    for (const layer of [regionsLayer, objectsLayer]) {
      if (!layer?.objects) continue;
      for (const obj of layer.objects) {
        obj.x = (obj.x ?? 0) + shiftX;
        obj.y = (obj.y ?? 0) + shiftY;
      }
    }
  }

  let maxId = 0;
  for (const layer of tmj.layers) {
    if (layer.objects) {
      for (const obj of layer.objects) {
        if (obj.id > maxId) maxId = obj.id;
      }
    }
  }

  // 追加新区域
  // 追加新区域。
  //
  // 去重两个维度：
  //   1. id 相同 —— 扩同一个地方两次，第二次不该再往 TMJ 里塞一个同名框
  //   2. 框完全相同 —— 视觉模型给两个区域返回了同一个框（实测
  //      「镇口石牌坊」「临河杂货铺」「巷口酒肆」共用 x2600,y40）
  //
  // 这类重复累积起来会让地图上出现好几个叠在一起的同名区域，
  // 角色不知道该去哪。重复的框直接丢弃，保留先来的那个。
  const existingRegionIds = new Set();
  const existingRegionBoxes = new Set();
  for (const obj of regionsLayer?.objects || []) {
    const propId = getTmjObjectProperties(obj).id;
    if (propId) existingRegionIds.add(propId);
    existingRegionBoxes.add(obj.x + "," + obj.y + "," + obj.width + "x" + obj.height);
  }

  const acceptedRegions = [];
  for (const r of parsed.regions) {
    const regionId = r.id || r.name;
    const boxKey =
      (r.topLeft?.x ?? 0) + "," + (r.topLeft?.y ?? 0) + "," +
      Math.max(1, (r.bottomRight?.x ?? 0) - (r.topLeft?.x ?? 0)) + "x" +
      Math.max(1, (r.bottomRight?.y ?? 0) - (r.topLeft?.y ?? 0));

    if (existingRegionIds.has(regionId)) {
      console.warn("[ExpandMap] Region '" + regionId + "' already in TMJ, skipped");
      continue;
    }
    if (existingRegionBoxes.has(boxKey)) {
      console.warn("[ExpandMap] Region '" + regionId + "' has the same box as an existing region, skipped");
      continue;
    }
    existingRegionIds.add(regionId);
    existingRegionBoxes.add(boxKey);
    acceptedRegions.push(r);

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
        { name: "id", type: "string", value: regionId },
        { name: "description", type: "string", value: r.description || "" },
        { name: "regionType", type: "string", value: r.type || "" },
        { name: "actions", type: "string", value: JSON.stringify(r.actions || []) },
        { name: "adjacentRegions", type: "string", value: JSON.stringify(r.adjacentRegions || []) },
      ],
    };
    if (regionsLayer?.objects) regionsLayer.objects.push(obj);
  }

  // 追加新物件
  const acceptedElements = [];
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
    acceptedElements.push(o);
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

  // 返回实际写进 TMJ 的区域。world.json 必须按这份清单来写——
  // 被去重跳过的区域不该在 world.json 里留一个没有对应框的地点。
  return { tmj, acceptedRegions, acceptedElements };
}

/** 画布变宽后，把碰撞层数据搬进新的网格，旧区域数据保持不变 */
/**
 * 扩容碰撞网格，把旧数据搬到新的正确位置。
 *
 * 旧网格在完整地图里的位置随扩展方向而变：
 *   right / bottom —— 旧图在左上角，新区在右侧/下方，偏移为 (0, 0)
 *   left          —— 新区在左侧，旧图要整体右移 offsetX 格
 *   top           —— 新区在上方，旧图要整体下移 offsetY 格
 *
 * 之前不管什么方向都把旧数据留在左上角，于是向左/向上扩展时，
 * 碰撞数据和背景图对不上——角色会在图上「撞墙」，但那里其实没有墙。
 *
 * @param {object} tmj - TMJ 对象（原地修改）
 * @param {number} oldW - 旧网格宽
 * @param {number} oldH - 旧网格高
 * @param {number} newW - 新网格宽
 * @param {number} newH - 新网格高
 * @param {number} offsetX - 旧网格在新网格中的 x 偏移（格）
 * @param {number} offsetY - 旧网格在新网格中的 y 偏移（格）
 */
export function resizeCollisionGrid(tmj, oldW, oldH, newW, newH, offsetX = 0, offsetY = 0) {
  const layer = findTmjLayer(tmj, "collision");
  if (!layer?.data) return;
  const oldData = layer.data;
  // 新增出来的格子默认是障碍（1），引导玩家走新区域
  const newData = new Array(newW * newH).fill(1);
  for (let y = 0; y < oldH; y++) {
    for (let x = 0; x < oldW; x++) {
      const nx = x + offsetX;
      const ny = y + offsetY;
      if (nx < 0 || ny < 0 || nx >= newW || ny >= newH) continue;
      newData[ny * newW + nx] = oldData[y * oldW + x];
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
export function updateWorldConfig(
  worldConfig,
  newRegions,
  newObjects,
  parsedRegions,
  parsedElements,
  onlyTheseIds = null,
) {
  const existingLocations = Array.isArray(worldConfig.locations) ? worldConfig.locations : [];
  const existingIds = new Set(existingLocations.map((l) => l.id));
  // 中心区域的 id —— 新区域挂到它上面。
  // 世界没声明就用默认的 "main_area"（迁移函数补的也是这个）。
  const centerLocationId =
    typeof worldConfig.centerLocationId === "string" &&
    worldConfig.centerLocationId.trim().length > 0
      ? worldConfig.centerLocationId
      : "main_area";

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
    // onlyTheseIds 非空时，只写真正进了 TMJ 的区域。
    // 被去重跳过的区域不该在 world.json 里留一个没有对应框的地点——
    // 那种地点在地图上点不到，角色也走不到。
    .filter((r) => !onlyTheseIds || onlyTheseIds.includes(r.id))
    .map((r) => {
      const location = {
        id: r.id,
        name: r.name,
        description: r.description || "",
        adjacentLocations: [centerLocationId],
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
  const collisionLayer = findTmjLayer(tmj, "collision");
  const regionsLayer = findTmjLayer(tmj, "regions");
  const objectsLayer = findTmjLayer(tmj, "interactive_objects");

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
  // 参数位置固定：<worldDir> <side> <userPrompt...>
  // side 是扩展方向（right/left/top/bottom/auto），auto 表示交给 LLM 判断。
  // 固定位置而不是靠「最后一个参数是不是方向名」来猜——userPrompt 含空格时
  // 会把 prompt 里的普通词误判成方向。
  const worldDir = process.argv[2];
  const sideArg = process.argv[3] || "auto";
  const userPrompt = process.argv.slice(4).join(" ");

  if (!worldDir || !userPrompt) {
    console.error("Usage: node expand-map.mjs <worldDir> <side> <userPrompt>");
    process.exit(1);
  }
  if (!EXPANSION_SIDES.includes(sideArg) && sideArg !== "auto") {
    console.error(
      "Invalid side: " + sideArg + " (expected one of " + EXPANSION_SIDES.join(", ") + " or auto)",
    );
    process.exit(1);
  }

  expandMap(worldDir, userPrompt, { side: sideArg })
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
