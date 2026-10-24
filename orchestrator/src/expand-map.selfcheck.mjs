/**
 * expand-map 逻辑自检（不调用任何模型 API）
 *
 * 覆盖本次修复的几个真实缺陷：
 *   1. 碰撞网格扩容顺序——新区域的像素坐标落在旧网格之外
 *   2. TMJ region id 与 world.json location id 必须一致
 *   3. 主区域点位必须带 name 与 adjacentPointIds（服务端依赖它判断可达性）
 *   4. SUCCESS 标记的输出格式
 *
 * 运行：node orchestrator/src/expand-map.selfcheck.mjs
 */
import {
  mergeTMJIncremental,
  resizeCollisionGrid,
  updateWorldConfig,
  rebuildMainAreaPoints,
  reconcileDesignedItems,
  convertVisionBoxToGlobal,
  buildVisionCoordinatePrompt,
  planTileSlices,
} from "./expand-map.mjs";
import { buildOutpaintCanvas } from "./outpaint-canvas.mjs";
import { computeTileGeometry, EXPANSION_GEOMETRY, isValidSide } from "./map-tile-generator.mjs";
import { normalizeExpandDesign } from "./world-design-utils.mjs";
import { readFileSync } from "fs";

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) {
    console.log("  PASS  " + label);
  } else {
    failures++;
    console.log("  FAIL  " + label + (detail ? "  -> " + detail : ""));
  }
}

// ─── 构造一个与真实世界同构的 TMJ ────────────────────────────────────────────
const TILE = 4;
const OLD_GRID_W = 480; // 1920px
const OLD_GRID_H = 180; // 720px
const TILE_W = 640; // 新地块宽度（像素）

function makeTMJ() {
  const w = OLD_GRID_W;
  const h = OLD_GRID_H;
  return {
    width: w,
    height: h,
    tilewidth: TILE,
    tileheight: TILE,
    layers: [
      { name: "background", type: "imagelayer", imagewidth: w * TILE, imageheight: h * TILE },
      { name: "collision", type: "tilelayer", width: w, height: h, data: new Array(w * h).fill(0) },
      {
        name: "regions",
        type: "objectgroup",
        objects: [
          {
            id: 1,
            name: "老茶馆",
            x: 100,
            y: 100,
            width: 200,
            height: 150,
            properties: [
              { name: "id", type: "string", value: "tea_house" },
              { name: "description", type: "string", value: "临街茶馆" },
              { name: "regionType", type: "string", value: "building" },
              { name: "actions", type: "string", value: "[]" },
              { name: "adjacentRegions", type: "string", value: "[]" },
            ],
          },
        ],
      },
      { name: "interactive_objects", type: "objectgroup", objects: [] },
    ],
  };
}

console.log("\n=== 1. 碰撞网格扩容顺序 ===");
{
  const tmj = makeTMJ();
  const oldW = tmj.width;
  const oldH = tmj.height;
  const newGridW = oldW + TILE_W / TILE; // 640px / 4 = 160 tiles

  // 先扩容，再合并（修复后的顺序）
  resizeCollisionGrid(tmj, oldW, oldH, newGridW, oldH);
  tmj.width = newGridW;
  tmj.height = oldH;

  // 新区域落在旧网格之外：x = 1920 + 100
  const newRegion = {
    id: "ruined_pagoda",
    name: "废弃古塔",
    description: "一座荒废的石塔",
    type: "building",
    topLeft: { x: 1920 + 100, y: 200 },
    bottomRight: { x: 1920 + 260, y: 420 },
  };

  mergeTMJIncremental(tmj, { regions: [newRegion], elements: [] }, []);

  const collision = tmj.layers.find((l) => l.name === "collision");
  const tx = Math.floor(newRegion.topLeft.x / TILE);
  const ty = Math.floor(newRegion.topLeft.y / TILE);
  const tile = collision.data[ty * tmj.width + tx];

  check("网格宽度已扩容", tmj.width === newGridW, `got ${tmj.width}`);
  check("碰撞层数据长度匹配新网格", collision.data.length === newGridW * oldH);
  check("新区块碰撞被清零（可通行）", tile === 0, `got ${tile} at tx=${tx}`);
  check("旧区域碰撞保持原样", collision.data[10 * tmj.width + 10] === 0);
}

console.log("\n=== 2. TMJ id 与 world.json location id 一致性 ===");
{
  const designed = [
    { id: "ruined_pagoda", name: "废弃古塔", description: "一座荒废的石塔", type: "building", enterable: true },
  ];
  // 视觉模型返回了不同的 id（真实故障：它会自己改写 id）
  const visionParsed = [
    {
      id: "pagoda-1",
      name: "废弃古塔",
      description: "一座荒废的石塔",
      type: "building",
      topLeft: { x: 100, y: 200 },
      bottomRight: { x: 260, y: 420 },
    },
  ];
  const toGlobal = (box) => ({
    topLeft: { x: box.topLeft.x + 1920, y: box.topLeft.y },
    bottomRight: { x: box.bottomRight.x + 1920, y: box.bottomRight.y },
  });

  const parsed = {
    regions: reconcileDesignedItems(visionParsed, designed, "region", toGlobal, {
      topLeft: { x: 1960, y: 40 },
      bottomRight: { x: 2520, y: 680 },
    }),
    elements: [],
  };

  check("对齐后使用设计阶段的 id", parsed.regions[0].id === "ruined_pagoda", parsed.regions[0].id);
  check("坐标已换算到全局", parsed.regions[0].topLeft.x === 2020, String(parsed.regions[0].topLeft.x));

  const tmj = makeTMJ();
  mergeTMJIncremental(tmj, parsed, []);

  const worldConfig = updateWorldConfig(
    { locations: [{ id: "main_area", name: "主区域", description: "", adjacentLocations: [], objects: [] }] },
    designed,
    [],
    parsed.regions,
    parsed.elements,
  );

  const tmjIds = tmj.layers
    .find((l) => l.name === "regions")
    .objects.map((o) => (o.properties.find((p) => p.name === "id") || {}).value);
  const locIds = worldConfig.locations.map((l) => l.id);

  check("TMJ 含新区域 id", tmjIds.includes("ruined_pagoda"), tmjIds.join(","));
  check("world.json 含新区域 id", locIds.includes("ruined_pagoda"), locIds.join(","));
  check(
    "TMJ 与 world.json 的新区域 id 一致",
    tmjIds.includes("ruined_pagoda") && locIds.includes("ruined_pagoda"),
    `tmj=[${tmjIds}] loc=[${locIds}]`,
  );
  check(
    "每个新增区域在两边都存在且不多不少",
    tmjIds.filter((i) => i === "ruined_pagoda").length === 1 &&
      locIds.filter((i) => i === "ruined_pagoda").length === 1,
  );
  check("新区域 adjacentLocations 指向 main_area", worldConfig.locations.at(-1).adjacentLocations.includes("main_area"));
}

console.log("\n=== 2b. 视觉漏检时不丢条目 ===");
{
  const designed = [
    { id: "ruined_pagoda", name: "废弃古塔", description: "塔", type: "building" },
    { id: "creek", name: "塔畔清溪", description: "溪", type: "outdoor" },
  ];
  const toGlobal = (b) => b;
  // 视觉只找到了一个
  const items = reconcileDesignedItems(
    [{ id: "ruined_pagoda", name: "废弃古塔", topLeft: {x:1,y:1}, bottomRight: {x:2,y:2} }],
    designed,
    "region",
    toGlobal,
    { topLeft: { x: 40, y: 40 }, bottomRight: { x: 600, y: 680 } },
  );
  check("漏检的条目被补回", items.length === 2, `got ${items.length}`);
  check("补回的条目带兜底坐标", !!items.find((i) => i.id === "creek")?.topLeft);
}

console.log("\n=== 3. 主区域点位带 name 与邻接关系 ===");
{
  // 用真实世界的 TMJ 才能反映真实的稠密度——
  // 完全空旷的合成网格会让点位间距过大，自然产生不了邻接关系。
  const worldPath = new URL("../../output/worlds/world_2026-10-20T11-06-51/", import.meta.url);
  let tmj = null;
  try {
    const raw = readFileSync(new URL("map/06-final.tmj", worldPath), "utf-8");
    tmj = JSON.parse(raw);
  } catch (e) {
    console.log("  SKIP  找不到真实世界 TMJ，跳过");
  }

  if (tmj) {
    const points = rebuildMainAreaPoints(tmj);

    check("生成了主区域点位", points.length > 0, `got ${points.length}`);
    // 网格点位上限 24；每个可交互物件还会额外产生一个「靠近点」
    const gridPoints = points.filter((p) => !p.id.startsWith("element_"));
    const elementPoints = points.filter((p) => p.id.startsWith("element_"));
    check("网格点位数量在合理范围（<= 24）", gridPoints.length <= 24, `got ${gridPoints.length}`);
    check(
      "每个可交互物件都有靠近点",
      elementPoints.length ===
        tmj.layers.find((l) => l.name === "interactive_objects").objects.length,
      `${elementPoints.length} points for ${tmj.layers.find((l) => l.name === "interactive_objects").objects.length} objects`,
    );
    check("每个点位都有 name", points.every((p) => typeof p.name === "string" && p.name.length > 0));
    check("每个点位都有 adjacentPointIds 数组", points.every((p) => Array.isArray(p.adjacentPointIds)));
    check(
      "至少有点位之间存在邻接关系",
      points.some((p) => p.adjacentPointIds.length > 0),
      `${points.filter((p) => p.adjacentPointIds.length > 0).length}/${points.length}`,
    );
    const ids = new Set(points.map((p) => p.id));
    check(
      "邻接关系只指向存在的点位",
      points.every((p) => p.adjacentPointIds.every((a) => ids.has(a))),
    );
    check(
      "点位 id 唯一",
      ids.size === points.length,
      `${ids.size} vs ${points.length}`,
    );
  }
}

console.log("\n=== 4. 旧区域碰撞数据在扩容后保持不变 ===");
{
  const tmj = makeTMJ();
  const collision = tmj.layers.find((l) => l.name === "collision");
  collision.data[5 * OLD_GRID_W + 7] = 1; // 标记一个障碍
  const oldW = tmj.width;
  const newGridW = oldW + TILE_W / TILE;

  resizeCollisionGrid(tmj, oldW, tmj.height, newGridW, tmj.height);
  tmj.width = newGridW;

  check("旧障碍仍为障碍", collision.data[5 * tmj.width + 7] === 1);
  check("扩容出来的新列默认是障碍", collision.data[5 * tmj.width + (oldW + 3)] === 1);
}

console.log("\n=== 5. 上下文裁剪：画布尺寸可控且新区位置正确 ===");
{
  const sharp = (await import("sharp")).default;
  // 造一张 2000x1000 的假旧图
  const W = 2000;
  const H = 1000;
  const base = await sharp({
    create: { width: W, height: H, channels: 3, background: { r: 100, g: 110, b: 120 } },
  })
    .png()
    .toBuffer();

  const CROP = 768;
  const TILE = 640;

  const full = await buildOutpaintCanvas(base, {
    side: "right",
    tileWidth: TILE,
    contextWidth: 96,
  });
  const cropped = await buildOutpaintCanvas(base, {
    side: "right",
    tileWidth: TILE,
    contextWidth: 96,
    cropContextWidth: CROP,
  });

  check("不裁剪时画布 = 原图 + 新地块", full.canvasWidth === W + TILE, `${full.canvasWidth}`);
  check("裁剪后画布显著变小", cropped.canvasWidth === CROP + TILE, `${cropped.canvasWidth}`);
  check("裁剪后画布像素数下降", cropped.canvasWidth * cropped.canvasHeight < full.canvasWidth * full.canvasHeight);
  check("新区在裁剪画布中的位置正确", cropped.tileLeft === CROP, `${cropped.tileLeft}`);
  check("新区尺寸不变", cropped.tileWidth === TILE && cropped.tileHeight === H);
  check("裁剪信息记录了原图坐标", cropped.cropLeft === W - CROP && cropped.fullWidth === W);

  // mask 语义：旧图区=0（锁定），新区=255（生成）
  const mask = await sharp(cropped.mask).greyscale().raw().toBuffer();
  const px = (x, y) => mask[y * cropped.canvasWidth + x];
  check("mask 旧图区为 0（锁定）", px(10, 10) === 0, `got ${px(10, 10)}`);
  check("mask 新区为 255（生成）", px(CROP + 10, 10) === 255, `got ${px(CROP + 10, 10)}`);
  check("mask 接缝处切换", px(CROP - 1, 10) === 0 && px(CROP, 10) === 255);

  // 裁剪保留的旧图条带内容必须与原图对应区域一致
  // （canvas 是 RGBA，原图是 RGB，比较时按通道数取模）
  const strip = await sharp(cropped.canvas)
    .extract({ left: 0, top: 0, width: CROP, height: H })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const orig = await sharp(base)
    .extract({ left: W - CROP, top: 0, width: CROP, height: H })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = orig.info.channels;
  let same = true;
  for (let y = 0; y < H && same; y++) {
    for (let x = 0; x < CROP; x++) {
      for (let c = 0; c < ch; c++) {
        const si = (y * CROP + x) * strip.info.channels + c;
        const oi = (y * CROP + x) * ch + c;
        if (Math.abs(strip.data[si] - orig.data[oi]) > 2) {
          same = false;
          break;
        }
      }
      if (!same) break;
    }
  }
  check("裁剪的旧图条带与原图对应区域一致", same);
}

// ─── 6. 视觉坐标换算与越界裁剪 ──────────────────────────────────────────────
//
// 这一组覆盖的是真实事故：提示词声明的尺寸与实际送进模型的图片尺寸不一致，
// 模型照着声明尺寸返回坐标，代码又乘了一次缩放系数，坐标被放大两倍，
// region 框直接溢出画布（实测 y 报 3072，而新区实际只有 1536 高）。
{
  console.log("\n=== 6. 视觉坐标换算与越界裁剪 ===");

  // 复现真实参数：地块 640×1536，resizeTo(768) 后模型看到 320×768
  const TILE_W = 640;
  const TILE_H = 1536;
  const IMG_W = 320;
  const IMG_H = 768;
  const OFFSET_X = 2752;
  const OFFSET_Y = 0;
  const geom = {
    imgW: IMG_W,
    imgH: IMG_H,
    tileWidth: TILE_W,
    tileHeight: TILE_H,
    offsetX: OFFSET_X,
    offsetY: OFFSET_Y,
  };

  // 模型在 320×768 的图上正确返回一个框
  const ok = convertVisionBoxToGlobal(
    { topLeft: { x: 40, y: 100 }, bottomRight: { x: 200, y: 400 } },
    geom,
  );
  // 缩放 2 倍后应是 80/200 与 400/800，再加偏移 2752
  check("正常坐标按模型所见尺寸正确缩放", ok.topLeft.x === 2832, String(ok.topLeft.x));
  check("正常坐标 y 正确缩放", ok.topLeft.y === 200, String(ok.topLeft.y));
  check("正常坐标右下角正确", ok.bottomRight.x === 3152 && ok.bottomRight.y === 800);

  // 模型返回越界坐标（整条河报成 y=0..3072，模型图只有 768 高）
  const over = convertVisionBoxToGlobal(
    { topLeft: { x: 0, y: 0 }, bottomRight: { x: 1600, y: 1536 } },
    geom,
  );
  check(
    "越界的 x 被裁剪到新区右边界",
    over.bottomRight.x === OFFSET_X + TILE_W,
    String(over.bottomRight.x),
  );
  check(
    "越界的 y 被裁剪到新区下边界",
    over.bottomRight.y === OFFSET_Y + TILE_H,
    String(over.bottomRight.y),
  );
  check("裁剪后左边界仍在新区内", over.topLeft.x === OFFSET_X && over.topLeft.y === OFFSET_Y);

  // 负坐标（模型偶尔报负值）
  const neg = convertVisionBoxToGlobal(
    { topLeft: { x: -50, y: -20 }, bottomRight: { x: 100, y: 100 } },
    geom,
  );
  check("负坐标被拉回新区内", neg.topLeft.x === OFFSET_X && neg.topLeft.y === OFFSET_Y);
  check("负坐标不影响正常角点", neg.bottomRight.x === 2952 && neg.bottomRight.y === 200);

  // 关键回归：模型按【声明尺寸 640×1536】返回坐标时，不能被放大两倍。
  // 注意右下角仍会被裁剪到新区边界（2752+640=3392, 0+1536=1536），
  // 因为模型给的 400×800 在 640×1536 的图上是合法的，但换算时
  // 640/320=2 会把它推到新区外面——裁剪正是为了兜住这种情况。
  const declared = convertVisionBoxToGlobal(
    { topLeft: { x: 80, y: 200 }, bottomRight: { x: 400, y: 800 } },
    geom,
  );
  check(
    "模型按声明尺寸返回时坐标不翻倍",
    declared.topLeft.x === OFFSET_X + 160 && declared.topLeft.y === 400,
    `got ${declared.topLeft.x},${declared.topLeft.y}`,
  );
  check(
    "模型按声明尺寸返回时右下角被裁剪到新区边界",
    declared.bottomRight.x === OFFSET_X + TILE_W && declared.bottomRight.y === OFFSET_Y + TILE_H,
    `got ${declared.bottomRight.x},${declared.bottomRight.y}`,
  );

  // 提示词里声明的尺寸必须等于实际送进模型的图片尺寸——
  // 这才是根因：模型只认提示词里的数字。
  const prompt = buildVisionCoordinatePrompt({
    imgW: IMG_W,
    imgH: IMG_H,
    regions: [{ name: "古塔", description: "残破的八角砖塔" }],
    elements: [],
  });
  check("提示词声明的宽度等于实际图片宽度", prompt.includes(IMG_W + "×" + IMG_H), prompt.slice(0, 80));
  check("提示词没有声明地块原始尺寸", !prompt.includes(TILE_W + "×" + TILE_H));
}

// ─── 7. 四方向扩展几何 ──────────────────────────────────────────────────────
//
// 覆盖「地图只能横向扩展」这个限制的核心改动：
//   - 四个方向各自的新地块位置与画布尺寸
//   - 碰撞网格在向左/向上扩展时必须整体平移，否则旧数据留在左上角，
//     与背景图对不上——角色会在没墙的地方撞墙
{
  console.log("\n=== 7. 四方向扩展几何 ===");

  const BASE_W = 1920;
  const BASE_H = 720;
  const EXT = 640;
  const baseMeta = { width: BASE_W, height: BASE_H };

  check("4 个方向都合法", ["right", "left", "top", "bottom"].every(isValidSide));
  check("非法方向被拒绝", !isValidSide("diagonal"));

  // right：新区在右侧，画布变宽
  const gRight = computeTileGeometry(baseMeta, "right", EXT);
  check("right: 新区左边界 = 旧图宽", gRight.tileLeft === BASE_W, String(gRight.tileLeft));
  check("right: 新区上边界 = 0", gRight.tileTop === 0);
  check("right: 画布变宽不变高", gRight.canvasWidth === BASE_W + EXT && gRight.canvasHeight === BASE_H);
  check("right: 地块宽 = 增量，高 = 旧图高", gRight.tileWidth === EXT && gRight.tileHeight === BASE_H);

  // left：新区在左侧，旧图右移
  const gLeft = computeTileGeometry(baseMeta, "left", EXT);
  check("left: 新区左边界 = 0", gLeft.tileLeft === 0, String(gLeft.tileLeft));
  check("left: 画布变宽不变高", gLeft.canvasWidth === BASE_W + EXT && gLeft.canvasHeight === BASE_H);

  // bottom：新区在下，画布变高
  const gBottom = computeTileGeometry(baseMeta, "bottom", EXT);
  check("bottom: 新区上边界 = 旧图高", gBottom.tileTop === BASE_H, String(gBottom.tileTop));
  check("bottom: 画布变高不变宽", gBottom.canvasWidth === BASE_W && gBottom.canvasHeight === BASE_H + EXT);
  check("bottom: 地块高 = 增量，宽 = 旧图宽", gBottom.tileWidth === BASE_W && gBottom.tileHeight === EXT);

  // top：新区在上，旧图下移
  const gTop = computeTileGeometry(baseMeta, "top", EXT);
  check("top: 新区上边界 = 0", gTop.tileTop === 0);
  check("top: 画布变高不变宽", gTop.canvasWidth === BASE_W && gTop.canvasHeight === BASE_H + EXT);

  // 新增面积 = 地块面积 = 增量 × 垂直于扩展方向的旧图边长。
  // 水平扩展时是 640×720，垂直扩展时是 1920×640——因为垂直扩展的新区
  // 必须覆盖整个宽度。两者不等是几何必然，不是 bug。
  const addedArea = (g) => g.canvasWidth * g.canvasHeight - BASE_W * BASE_H;
  check("right 新增面积 = 增量 × 旧图高", addedArea(gRight) === EXT * BASE_H, String(addedArea(gRight)));
  check("left 新增面积 = 增量 × 旧图高", addedArea(gLeft) === EXT * BASE_H, String(addedArea(gLeft)));
  check("bottom 新增面积 = 增量 × 旧图宽", addedArea(gBottom) === EXT * BASE_W, String(addedArea(gBottom)));
  check("top 新增面积 = 增量 × 旧图宽", addedArea(gTop) === EXT * BASE_W, String(addedArea(gTop)));
  check(
    "左右方向新增面积相同",
    addedArea(gRight) === addedArea(gLeft) && addedArea(gTop) === addedArea(gBottom),
  );

  // ── 碰撞网格在向左扩展时必须右移 ──
  {
    const tmj = makeTMJ();
    const oldW = tmj.width;
    const oldH = tmj.height;
    // 在 (5,7) 放一个障碍
    tmj.layers.find((l) => l.name === "collision").data[7 * oldW + 5] = 1;

    // 向左扩：网格变宽 160 格，旧网格要右移 160 格
    const newW = oldW + 160;
    const offsetX = newW - oldW;
    resizeCollisionGrid(tmj, oldW, oldH, newW, oldH, offsetX, 0);

    const c = tmj.layers.find((l) => l.name === "collision");
    check("向左扩展: 网格变宽", c.width === newW, String(c.width));
    check(
      "向左扩展: 旧障碍跟着右移",
      c.data[7 * newW + (5 + offsetX)] === 1,
      `got ${c.data[7 * newW + (5 + offsetX)]}`,
    );
    check(
      "向左扩展: 原位置不再是障碍",
      c.data[7 * newW + 5] === 1,
      "左侧新区域默认应为障碍",
    );
  }

  // ── 碰撞网格在向上扩展时必须下移 ──
  {
    const tmj = makeTMJ();
    const oldW = tmj.width;
    const oldH = tmj.height;
    tmj.layers.find((l) => l.name === "collision").data[7 * oldW + 5] = 1;

    const newH = oldH + 160;
    const offsetY = newH - oldH;
    resizeCollisionGrid(tmj, oldW, oldH, oldW, newH, 0, offsetY);

    const c = tmj.layers.find((l) => l.name === "collision");
    check("向上扩展: 网格变高", c.height === newH, String(c.height));
    check(
      "向上扩展: 旧障碍跟着下移",
      c.data[(7 + offsetY) * oldW + 5] === 1,
      `got ${c.data[(7 + offsetY) * oldW + 5]}`,
    );
  }

  // ── 向右/向下扩展时旧数据位置不变 ──
  {
    const tmj = makeTMJ();
    const oldW = tmj.width;
    const oldH = tmj.height;
    tmj.layers.find((l) => l.name === "collision").data[7 * oldW + 5] = 1;

    resizeCollisionGrid(tmj, oldW, oldH, oldW + 160, oldH, 0, 0);
    const c = tmj.layers.find((l) => l.name === "collision");
    check("向右扩展: 旧障碍留在原位", c.data[7 * c.width + 5] === 1);
  }

  // ── 画布构造：4 个方向都正确 ──
  {
    const sharp = (await import("sharp")).default;
    const base = await sharp({
      create: { width: 400, height: 300, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toBuffer();

    const g = EXPANSION_GEOMETRY;
    const right = await buildOutpaintCanvas(base, { side: "right", tileWidth: 100 });
    check("画布 right: 宽 = 旧宽 + 增量", right.canvasWidth === 500 && right.canvasHeight === 300);
    check("画布 right: 新区在右侧", right.tileLeft === 400 && right.tileTop === 0);

    const left = await buildOutpaintCanvas(base, { side: "left", tileWidth: 100 });
    check("画布 left: 宽 = 旧宽 + 增量", left.canvasWidth === 500 && left.canvasHeight === 300);
    check("画布 left: 新区在左侧", left.tileLeft === 0);

    const bottom = await buildOutpaintCanvas(base, { side: "bottom", tileWidth: 100 });
    check("画布 bottom: 高 = 旧高 + 增量", bottom.canvasWidth === 400 && bottom.canvasHeight === 400);
    check("画布 bottom: 新区在下", bottom.tileTop === 300);

    const top = await buildOutpaintCanvas(base, { side: "top", tileWidth: 100 });
    check("画布 top: 高 = 旧高 + 增量", top.canvasWidth === 400 && top.canvasHeight === 400);
    check("画布 top: 新区在上", top.tileTop === 0);

    check("4 个方向的几何定义齐全", !!g.right && !!g.left && !!g.top && !!g.bottom);
  }

  // ── 合并时旧 region/物件必须按扩展方向平移 ──
  //
  // 向上扩展时新区插在旧图上方，旧图整体下移 640 像素。
  // 旧 region 的像素坐标若不平移，就会标注到新区的位置上——
  // 客户端会显示错位的区域框。
  {
    const tmj = makeTMJ();
    const regionsLayer = tmj.layers.find((l) => l.name === "regions");
    const objectsLayer = tmj.layers.find((l) => l.name === "interactive_objects");
    const ri = regionsLayer.objects.length;
    const oi = objectsLayer.objects.length;
    regionsLayer.objects.push({ id: 99, name: "old_region", x: 100, y: 200, width: 50, height: 60, properties: [{ name: "id", value: "old_region" }] });
    objectsLayer.objects.push({ id: 99, name: "old_obj", x: 300, y: 400, width: 20, height: 20, properties: [{ name: "objectId", value: "old_obj" }] });

    // 向上扩展 640 像素：旧图下移 640
    const SHIFT = 640;
    mergeTMJIncremental(tmj, { regions: [], elements: [] }, [], 0, SHIFT);

    const movedRegion = regionsLayer.objects[ri];
    const movedObject = objectsLayer.objects[oi];
    check("向上扩展: 旧 region 的 y 平移", movedRegion.y === 200 + SHIFT, String(movedRegion.y));
    check("向上扩展: 旧 region 的 x 不变", movedRegion.x === 100, String(movedRegion.x));
    check("向上扩展: 旧物件的 y 平移", movedObject.y === 400 + SHIFT, String(movedObject.y));
    check("向上扩展: 旧 region 的 id 属性不变", movedRegion.properties[0].value === "old_region");
    check("向上扩展: 原有 region 也被平移", regionsLayer.objects[0].y === 100 + SHIFT, String(regionsLayer.objects[0].y));
  }

  // 向左扩展：旧图右移
  {
    const tmj = makeTMJ();
    const regionsLayer = tmj.layers.find((l) => l.name === "regions");
    const ri = regionsLayer.objects.length;
    regionsLayer.objects.push({ id: 99, name: "r", x: 100, y: 200, width: 50, height: 60, properties: [] });

    const SHIFT = 640;
    mergeTMJIncremental(tmj, { regions: [], elements: [] }, [], SHIFT, 0);

    check("向左扩展: 旧 region 的 x 平移", regionsLayer.objects[ri].x === 100 + SHIFT, String(regionsLayer.objects[ri].x));
    check("向左扩展: 旧 region 的 y 不变", regionsLayer.objects[ri].y === 200, String(regionsLayer.objects[ri].y));
  }

  // 向右扩展：旧图不动
  {
    const tmj = makeTMJ();
    const regionsLayer = tmj.layers.find((l) => l.name === "regions");
    const ri = regionsLayer.objects.length;
    regionsLayer.objects.push({ id: 99, name: "r", x: 100, y: 200, width: 50, height: 60, properties: [] });

    mergeTMJIncremental(tmj, { regions: [], elements: [] }, [], 0, 0);

    check("向右扩展: 旧 region 坐标不变", regionsLayer.objects[ri].x === 100 && regionsLayer.objects[ri].y === 200);
  }
}

// ─── 8. 长条形新区的分块解析 ────────────────────────────────────────────────
//
// 垂直扩展时新区是 3200x640 的长条，缩到 768 后只剩 154 高，
// 视觉模型在这种比例下会退化，把整个新区当成一个区域返回。
// 所以长条要切成接近方形的块分别定位。
{
  console.log("\n=== 8. 长条形新区分块 ===");

  const plan = planTileSlices;

  // 接近方形：不用切
  check(
    "近方形不切块",
    plan(640, 720).length === 1,
    String(plan(640, 720).length),
  );

  // 长条（垂直扩展的新区）：按宽度切
  const wide = plan(3200, 640);
  check("3200x640 切成多块", wide.length > 1, String(wide.length));
  check(
    "块数尽量少（每次分块都是一次视觉调用，可能超时重试）",
    wide.length <= 4,
    String(wide.length),
  );
  check(
    "每块宽度接近高度",
    wide.every((s) => s.height === 640 && s.width <= 640 * 2),
    JSON.stringify(wide.map((s) => s.width)),
  );  check(
    "切块覆盖整个新区宽度",
    wide.reduce((sum, s) => sum + s.width, 0) === 3200,
    String(wide.reduce((sum, s) => sum + s.width, 0)),
  );
  check("切块首尾相接无缝隙", wide[0].left === 0 && wide.every((s, i) => i === 0 || s.left === wide[i - 1].left + wide[i - 1].width));
  check(
    "每块比例在 0.5~2 之间（模型定位不退化）",
    wide.every((s) => {
      const a = s.width / s.height;
      return a >= 0.5 && a <= 2;
    }),
    JSON.stringify(wide.map((s) => (s.width / s.height).toFixed(2))),
  );

  // 高条（横向扩展、地图本身很高的情况）：按高度切
  const tall = plan(640, 3200);
  check("640x3200 切成多块", tall.length > 1, String(tall.length));
  check(
    "高条切块覆盖整个高度",
    tall.reduce((sum, s) => sum + s.height, 0) === 3200,
  );

  // ── 同一区域在多块里被返回时只保留一份 ──
  {
    const designed = [
      { id: "a", name: "区域A", description: "" },
      { id: "b", name: "区域B", description: "" },
    ];
    // 视觉在两块里都返回了区域A（分块时的典型重复）
    const parsed = [
      { id: "a", name: "区域A", topLeft: { x: 0, y: 0 }, bottomRight: { x: 10, y: 10 } },
      { id: "a", name: "区域A", topLeft: { x: 50, y: 50 }, bottomRight: { x: 60, y: 60 } },
    ];
    const items = reconcileDesignedItems(
      parsed,
      designed,
      "region",
      (b) => b,
      { topLeft: { x: 0, y: 0 }, bottomRight: { x: 1, y: 1 } },
      { allowOrderFallback: false },
    );
    check("重复区域只保留一份", items.filter((i) => i.id === "a").length === 1, String(items.length));
    check("保留的是第一次匹配到的坐标", items.find((i) => i.id === "a").topLeft.x === 0);
  }

  // ── 分块模式下禁用顺序兜底（避免坐标安到错的区域）──
  {
    const designed = [
      { id: "a", name: "区域A", description: "" },
      { id: "b", name: "区域B", description: "" },
    ];
    // 视觉返回了一个完全陌生的条目
    const parsed = [{ id: "zzz", name: "不认识的东西", topLeft: { x: 1, y: 1 }, bottomRight: { x: 2, y: 2 } }];
    const items = reconcileDesignedItems(
      parsed,
      designed,
      "region",
      (b) => b,
      { topLeft: { x: 0, y: 0 }, bottomRight: { x: 1, y: 1 } },
      { allowOrderFallback: false },
    );
    check(
      "分块模式下陌生条目不占用设计项",
      !items.some((i) => i.id === "a" && i.topLeft.x === 1),
      "陌生条目不应把坐标安到设计项 A 上",
    );
    check(
      "陌生条目被跳过后设计项走占位框",
      items.filter((i) => i.id === "b").length === 1,
    );
    check(
      "被占位框兜底的区域用的是占位坐标而非模型坐标",
      items.find((i) => i.id === "a").topLeft.x === 0 && items.find((i) => i.id === "a").bottomRight.x === 1,
      JSON.stringify(items.find((i) => i.id === "a")),
    );
  }

  // ── 提示词在分块模式下要求跳过不在本块的区域 ──
  {
    const p1 = buildVisionCoordinatePrompt({
      imgW: 768,
      imgH: 154,
      regions: [{ id: "region_1", name: "区域A", description: "x" }],
      elements: [],
    });
    const p2 = buildVisionCoordinatePrompt({
      imgW: 768,
      imgH: 154,
      regions: [{ id: "region_1", name: "区域A", description: "x" }],
      elements: [],
      sliceNote: true,
    });
    check("单块提示词没有跳过说明", !p1.includes("直接跳过"));
    check("分块提示词要求跳过不在本块的区域", p2.includes("直接跳过"));
    check("分块提示词仍然声明了尺寸", p2.includes("768×154"), p2.slice(0, 80));
    check("提示词把 id 给了模型", p2.includes('id="region_1"'));
    check("提示词要求原样回填 id", p2.includes("原样使用上面给出的 id"));
  }

  // ── 视觉模型把 id 音译了时，按名字兜底 ──
  {
    const designed = [{ id: "green_bamboo_grove", name: "青竹林", description: "" }];
    // 模型自己编了个拼音 id
    const parsed = [
      { id: "qingzhulin", name: "青竹林", topLeft: { x: 10, y: 20 }, bottomRight: { x: 30, y: 40 } },
    ];
    const items = reconcileDesignedItems(
      parsed,
      designed,
      "region",
      (b) => b,
      { topLeft: { x: 0, y: 0 }, bottomRight: { x: 1, y: 1 } },
      { allowOrderFallback: false },
    );
    check(
      "id 音译后按名字匹配成功",
      items.length === 1 && items[0].id === "green_bamboo_grove",
      JSON.stringify(items.map((i) => i.id)),
    );
    check(
      "匹配成功时保留模型给的坐标",
      items[0] && items[0].topLeft.x === 10 && items[0].bottomRight.y === 40,
      JSON.stringify(items[0]),
    );
  }

  // ── 同一区域在多块里返回时，挑最像样的那个 ──
  //
  // 视觉模型在看不见该区域的那块里也会给一个坐标，通常是 0,0->1,1
  // 这种退化框。取「第一个」会正好选中退化框——必须按面积挑。
  {
    const designed = [{ id: "grove", name: "竹林", description: "" }];
    const parsed = [
      // 块 1：模型没看到，给了退化框
      { id: "grove", name: "竹林", topLeft: { x: 0, y: 0 }, bottomRight: { x: 1, y: 1 } },
      // 块 3：模型看到了，给了真实框
      { id: "grove", name: "竹林", topLeft: { x: 100, y: 50 }, bottomRight: { x: 400, y: 300 } },
    ];
    const items = reconcileDesignedItems(
      parsed,
      designed,
      "region",
      (b) => b,
      { topLeft: { x: 0, y: 0 }, bottomRight: { x: 1, y: 1 } },
    );
    check("多候选取面积最大的（而非第一个）", items.length === 1 && items[0].topLeft.x === 100, JSON.stringify(items));
    check("多候选时没有退化框", items[0].bottomRight.x === 400 && items[0].bottomRight.y === 300);
  }

  // ── 分块坐标换算：toGlobal 收的是整个框，不是点 ──────────────────────────
  //
  // 之前分块循环里写的是 toGlobal(r.topLeft)——传进去的是「左上角这个点」，
  // 而 convertVisionBoxToGlobal 内部读的是 box.topLeft / box.bottomRight。
  // 于是所有坐标算出来都是 0，框塌缩成一点（面积 0），
  // 新区域的坐标在 TMJ 里退化成 0->1。
  {
    const geom = { imgW: 768, imgH: 154, tileWidth: 640, tileHeight: 640, offsetX: 640, offsetY: 0 };
    // 整框传进去
    const whole = convertVisionBoxToGlobal(
      { topLeft: { x: 100, y: 50 }, bottomRight: { x: 400, y: 300 } },
      geom,
    );
    // 只传左上角这个点（错误用法）
    const point = convertVisionBoxToGlobal(
      { topLeft: { x: 100, y: 50 }, bottomRight: { x: 400, y: 300 } }.topLeft,
      geom,
    );
    check(
      "整框换算得到非零面积",
      (whole.bottomRight.x - whole.topLeft.x) * (whole.bottomRight.y - whole.topLeft.y) > 0,
      JSON.stringify(whole),
    );
    check(
      "只传点会塌缩成零面积（这正是 bug）",
      (point.bottomRight.x - point.topLeft.x) * (point.bottomRight.y - point.topLeft.y) === 0,
      JSON.stringify(point),
    );
  }

  // ── 兜底框按格分配，不共用一个大框 ──
  {
    const designed = [
      { id: "a", name: "区域A", description: "" },
      { id: "b", name: "区域B", description: "" },
    ];
    const items = reconcileDesignedItems([], designed, "region", (b) => b, (_d, index) => ({
      topLeft: { x: index * 100, y: 0 },
      bottomRight: { x: index * 100 + 80, y: 80 },
    }));
    check("兜底框按序分配到不同格子", items.length === 2);
    check(
      "两个兜底框不重叠",
      items[0].topLeft.x !== items[1].topLeft.x,
      JSON.stringify(items.map((i) => i.topLeft)),
    );
  }

  // ── 设计阶段同名区域去重 ──
  {
    const design = normalizeExpandDesign({
      regions: [
        { id: "qingzhulin", name: "青竹林", description: "a" },
        { id: "green_bamboo_grove", name: "青竹林", description: "b" },
        { id: "other", name: "别的地方", description: "c" },
      ],
      interactiveElements: [],
    });
    check(
      "同名区域被去重",
      design.regions.filter((r) => r.name === "青竹林").length === 1,
      String(design.regions.length),
    );
    check("去重后保留第一个 id", design.regions[0].id === "qingzhulin", design.regions[0].id);
    check("不同名的区域不受影响", design.regions.length === 2, String(design.regions.length));
  }
}

console.log("\n" + (failures === 0 ? "全部通过 ✅" : failures + " 项失败 ❌"));
process.exit(failures === 0 ? 0 : 1);