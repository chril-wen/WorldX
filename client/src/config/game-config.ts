/**
 * 每格边长（像素）。
 *
 * 地图数据层在 `@worldx/client-core`，那边用的是 `DEFAULT_TILE_SIZE`
 * （同一个值 32）。这里保留是为了 client 自己的代码读起来顺。
 */
export const TILE_SIZE = 32;

/**
 * 中心区域的默认 id —— 世界的公共枢纽。
 *
 * 角色在里面用 `mainAreaPointId` 点位寻址。
 *
 * **这一份是从 core re-export 的** —— 改造前 client 和 core 各定义一次，
 * 值相同，注释里还互相声明「是同一个值」。阶段 4 刚处理过同一类问题
 * （两份逐字重复的 `normalizeLocations`），再留一份就是在复发。
 *
 * 真正的值从 `/world/info` 的 `centerLocationId` 来 ——
 * 旧世界都叫 "main_area"，所以默认值让行为跟之前完全一致。
 */
export { DEFAULT_CENTER_LOCATION_ID } from "@worldx/client-core";

export const SPRITE_FRAME_WIDTH = 170;
export const SPRITE_FRAME_HEIGHT = 204;
export const SPRITE_COLUMNS = 6;
export const SPRITE_ROWS = 5;
export const SPRITE_WALK_FRAME_RATE = 8;

const CHARACTER_HEIGHT_SUM_RATIO = 0.04;

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

export const CHARACTER_COLORS = [
  0x6c5ce7, 0x74b9ff, 0xd63031, 0xe17055,
  0x00b894, 0xfd79a8, 0xfdcb6e, 0xe84393,
];

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

export function actionToEmoji(action: string | null): string {
  if (!action) return "";
  return ACTION_EMOJI[action] || "";
}

export function getCharacterColor(index: number): number {
  return CHARACTER_COLORS[index % CHARACTER_COLORS.length];
}
