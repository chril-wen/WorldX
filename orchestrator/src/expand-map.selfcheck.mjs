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
} from "./expand-map.mjs";
import { buildOutpaintCanvas } from "./outpaint-canvas.mjs";
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

console.log("\n" + (failures === 0 ? "全部通过 ✅" : failures + " 项失败 ❌"));
process.exit(failures === 0 ? 0 : 1);
