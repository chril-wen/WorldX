/**
 * 角色的显示度量 —— **世界单位**的尺寸，不含任何渲染实现细节。
 *
 * ## 为什么搬到这里
 *
 * 阶段 8.1 要把「位置计算」从 Phaser 场景搬进 client-core。
 * 位置计算不只是「角色站在哪」——还包括：
 *
 * - 角色贴图多大（`spriteWidth` / `spriteHeight`）
 * - 气泡挂在头顶多高（`bubbleOffsetY`）
 * - 名牌挂在头顶多高（`getHeadWorldOffset`）
 * - 谁盖住谁（`sortFootYOffset`，按脚底 y 排序）
 *
 * 这些**全是位置**，只是长得不像位置（长得像「样式」）。
 * 留在 client 里的话，8.2 的渲染实现就得自己再抄一份 ——
 * 抄出来的数值迟早跟原版对不上（角色会浮起来或者陷进地里）。
 *
 * 所以它们跟着位置逻辑一起搬。
 *
 * ## 「世界单位」是什么意思
 *
 * 这里的尺寸**不是屏幕像素**，是**世界像素**。
 *
 * 角色在地图上的大小跟相机缩放无关 —— 缩放时它跟着地图一起缩放。
 * 所以尺寸只能是世界单位的，渲染实现乘一次变换矩阵就对了。
 *
 * （DOM 覆盖层是例外：名牌和气泡的**字号**随缩放变，
 * 但那是 `OverlayItem.zoom` 的事，实现自己按自己的规则 clamp。）
 *
 * ## 跟 client 的关系
 *
 * client 侧的 `config/game-config.ts` 变成**门面**，
 * 从这里 re-export —— 既有 import 路径不破（跟 `MapManager` 一样的做法）。
 */

/** 贴图单帧的宽（像素）。 */
export const SPRITE_FRAME_WIDTH = 170;
/** 贴图单帧的高（像素）。 */
export const SPRITE_FRAME_HEIGHT = 204;
/** 贴图集的列数。 */
export const SPRITE_COLUMNS = 6;
/** 贴图集的行数。 */
export const SPRITE_ROWS = 5;
/** 走路动画的帧率。 */
export const SPRITE_WALK_FRAME_RATE = 8;

/**
 * 角色高度占地图尺寸的比例。
 *
 * 角色大小跟地图大小挂钩 —— 地图大，角色相对就小，
 * 这样不管多大的地图，看起来的人物比例都差不多。
 */
const CHARACTER_HEIGHT_SUM_RATIO = 0.04;

/**
 * 角色的显示度量 —— 全部是世界单位。
 *
 * 字段跟改造前 client 的 `CharacterDisplayMetrics` **逐字相同**，
 * 只是搬了个家（`client/src/config/game-config.ts` → 这里）。
 */
export interface CharacterDisplayMetrics {
  spriteWidth: number;
  spriteHeight: number;
  hitWidth: number;
  hitHeight: number;
  hitTopY: number;
  circleRadius: number;
  circleStrokeWidth: number;
  circleHighlightRadius: number;
  circleHighlightOffsetX: number;
  circleHighlightOffsetY: number;
  shadowWidth: number;
  shadowHeight: number;
  shadowOffsetY: number;
  bubbleOffsetY: number;
  bubbleFontSize: number;
  bubbleWrapWidth: number;
  bubblePadding: number;
  bubbleTailHeight: number;
  bubbleCornerRadius: number;
  labelNameWorldSize: number;
  labelMbtiWorldSize: number;
  labelIconWorldSize: number;
  labelGapWorld: number;
  labelMbtiPadXWorld: number;
  labelMbtiPadYWorld: number;
  sortFootYOffset: number;
}

/**
 * 按地图尺寸算角色的显示度量。
 *
 * **逐字搬自** client 的 `createCharacterDisplayMetrics` ——
 * 数值一个都没改（改了角色就会突然变大变小）。
 */
export function createCharacterDisplayMetrics(
  mapWidth: number,
  mapHeight: number,
): CharacterDisplayMetrics {
  const spriteHeight = (mapWidth + mapHeight) * CHARACTER_HEIGHT_SUM_RATIO;
  const spriteWidth = spriteHeight * (SPRITE_FRAME_WIDTH / SPRITE_FRAME_HEIGHT);

  return {
    spriteWidth,
    spriteHeight,
    hitWidth: spriteWidth * 0.75,
    hitHeight: spriteHeight * 0.95,
    hitTopY: -spriteHeight * 0.8,
    circleRadius: spriteWidth * 0.45,
    circleStrokeWidth: Math.max(1.5, spriteWidth * 0.075),
    circleHighlightRadius: spriteWidth * 0.2,
    circleHighlightOffsetX: -spriteWidth * 0.125,
    circleHighlightOffsetY: -spriteWidth * 0.125,
    shadowWidth: spriteWidth * 0.3,
    shadowHeight: Math.max(2, spriteWidth * 0.125),
    shadowOffsetY: Math.max(2, spriteWidth * 0.1),
    bubbleOffsetY: -spriteHeight * 1.12,
    bubbleFontSize: Math.max(16, spriteHeight * 0.17),
    bubbleWrapWidth: Math.max(spriteWidth * 1.65, spriteHeight * 2.1),
    bubblePadding: Math.max(8, spriteHeight * 0.06),
    bubbleTailHeight: Math.max(4, spriteHeight * 0.035),
    bubbleCornerRadius: Math.max(6, spriteHeight * 0.045),
    labelNameWorldSize: spriteWidth * 0.20,
    labelMbtiWorldSize: spriteWidth * 0.20,
    labelIconWorldSize: spriteWidth * 0.21,
    labelGapWorld: spriteWidth * 0.07,
    labelMbtiPadXWorld: spriteWidth * 0.14,
    labelMbtiPadYWorld: spriteWidth * 0.045,
    sortFootYOffset: spriteHeight * 0.16,
  };
}

/**
 * 角色的配色（没有贴图时的兜底圆）。
 *
 * 按角色在列表里的序号取 —— 序号不同颜色不同，
 * 这样一堆角色挤在一起时能分清谁是谁。
 */
export const CHARACTER_COLORS = [
  0x6c5ce7, 0x74b9ff, 0xd63031, 0xe17055,
  0x00b894, 0xfd79a8, 0xfdcb6e, 0xe84393,
];

/** 动作 → emoji。渲染实现按自己的方式画这个图标。 */
export const ACTION_EMOJI: Record<string, string> = {
  cook: "🍳", eat: "🍽️", read: "📖",
  read_bulletin: "📰", write_diary: "📝", talk: "💬", talking: "💬", in_conversation: "💬", idle: "💭",
  fish: "🎣", explore: "🔍", repair: "🔧",
  think_in_bed: "💭", post_dialogue: "🙂", traveling: "🚶",
  people_watch: "👀", use_computer: "💻", have_drink: "☕", craft: "🔨", stroll: "🚶", tend_garden: "🌱", post_message: "📌",
  garden: "🌱", water_plants: "💧", plant_seeds: "🌱", harvest_crops: "🥕",
  buy_goods: "🛒", stock_shelves: "📦", clean_shop: "🧹",
  rest: "🛋️", sleep: "😴", relax: "🌿", sit: "🪑",
  pray: "🙏", perform: "🎭", play_music: "🎵",
  train: "💪", work: "🧰", study: "📚", observe: "👀",
};

/** 动作 → emoji；没有对应 emoji 就返回空串。 */
export function actionToEmoji(action: string | null): string {
  if (!action) return "";
  return ACTION_EMOJI[action] || "";
}

/** 按序号取角色颜色。 */
export function getCharacterColor(index: number): number {
  return CHARACTER_COLORS[index % CHARACTER_COLORS.length];
}

/**
 * 数字颜色（`0xffd166`）→ CSS 颜色字符串（`"#ffd166"`）。
 *
 * ## 为什么要有这个函数
 *
 * 渲染契约里颜色**一律用 CSS 字符串**（见 `render-model.ts` 的说明）——
 * 数字颜色和 CSS 字符串是两种写法，每种渲染实现都得转一次，
 * 转法还可能不一致（`rgb(r,g,b)` vs `#rrggbb`）。
 *
 * 转换只做一次，在这里做。
 *
 * 小写还是大写都行，但**统一小写** —— 颜色比较（测试里逐点相等）
 * 是按字符串比的，大小写不一致会假报差异。
 */
export function toCssColor(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}
