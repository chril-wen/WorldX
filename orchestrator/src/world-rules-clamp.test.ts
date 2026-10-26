import { describe, it, expect } from "vitest";
import { generateConfigs } from "./config-generator.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mergeRules } from "@own-world/core";

/**
 * 规则值在**写盘时**被规范化 —— 审阅阶段 2.5 时补的。
 *
 * ## 背景
 *
 * 设计流程的规则是 **LLM 直出**的。提示词里写「0-1，默认 0.95」
 * 是**建议**，不是**保证** —— LLM 会给出 1.8。
 *
 * engine 的 `mergeRules()` 会把越界的值夹回区间，所以世界不会崩。
 * 但如果 world.json 里存的是 1.8、实际跑的是 1.0 ——
 * **world.json 说的就不是实际在跑的**。
 *
 * 这正是 2.5 汇报里点名的「规则有一半是假的」那类问题：
 * 规则必须**改了立刻生效，且存的和跑的是同一个值**。
 *
 * 所以写盘前要把规则规范化成**实际生效的值**。
 */

const TMJ = {
  width: 32,
  height: 32,
  tilewidth: 16,
  tileheight: 16,
  infinite: false,
  layers: [
    { name: "regions", type: "objectgroup", objects: [] },
    { name: "interactive_objects", type: "objectgroup", objects: [] },
    { name: "collision", type: "objectgroup", objects: [] },
  ],
};

function makeWorldDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "worldx-rules-clamp-"));
  mkdirSync(join(dir, "map"), { recursive: true });
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(join(dir, "map", "06-final.tmj"), JSON.stringify(TMJ), "utf-8");
  return dir;
}

const BASE_DESIGN = {
  worldName: "测试世界",
  worldDescription: "一个用于测试的世界",
  worldSocialContext: "测试用",
  contentLanguage: "zh",
  sceneType: "closed",
  timeConfig: {
    startTime: "08:00",
    endTime: "23:00",
    tickDurationMinutes: 15,
    maxTicks: 20,
    displayFormat: "modern",
  },
  multiDay: {
    endOfDayText: "end",
    newDayText: "new",
    nextDayStartTime: "08:00",
  },
  mapPlan: {
    buildingMode: "mostly_scenic",
    compositionNotes: "测试",
    worldFunctionSummary: "测试",
    regionDesignNotes: "测试",
  },
  regions: [
    {
      id: "main_area",
      name: "主区域",
      description: "测试主区域",
      size: { width: 20, height: 15 },
    },
  ],
  interactiveElements: [],
  characters: [
    {
      name: "甲",
      role: "路人",
      personality: "普通",
      appearance: "普通打扮",
      appearanceHint: "普通",
      motivation: "活着",
      socialStyle: "introvert",
      initialMemories: [],
    },
  ],
  worldActions: [],
};

async function writeWorld(design: any) {
  const dir = makeWorldDir();
  await generateConfigs(design, dir, { originalPrompt: "测试" });
  const world = JSON.parse(
    readFileSync(join(dir, "config", "world.json"), "utf-8"),
  );
  return { dir, world };
}

describe("world.json 存的就是实际在跑的值", () => {
  it("越界的值在写盘前被夹回区间", async () => {
    const { dir, world } = await writeWorld({
      ...BASE_DESIGN,
      rules: { emotion: { decayRate: 1.8 } },
    });
    try {
      // 存的是夹过的值，不是 LLM 给的 1.8
      expect(world.rules.emotion.decayRate).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("world.json 里的值和引擎实际生效的值一致", async () => {
    const { dir, world } = await writeWorld({
      ...BASE_DESIGN,
      rules: { emotion: { decayRate: 1.8 }, memory: { consolidateImportance: 0 } },
    });
    try {
      // 引擎读 world.json 后合并出的规则
      const effective = mergeRules(world.rules);
      expect(effective.emotion.decayRate).toBe(world.rules.emotion.decayRate);
      expect(effective.memory.consolidateImportance).toBe(
        world.rules.memory.consolidateImportance,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("合法的值一个都不动", async () => {
    const { dir, world } = await writeWorld({
      ...BASE_DESIGN,
      rules: { emotion: { decayRate: 0.8 } },
    });
    try {
      expect(world.rules).toEqual({ emotion: { decayRate: 0.8 } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("只写显式的项，不把 37 个默认值全塞进 world.json", async () => {
    const { dir, world } = await writeWorld({
      ...BASE_DESIGN,
      rules: { emotion: { decayRate: 0.8 } },
    });
    try {
      // 「只写要改的项」是规则层的约定 —— 写全了 world.json 就没法看了
      expect(Object.keys(world.rules)).toEqual(["emotion"]);
      expect(Object.keys(world.rules.emotion)).toEqual(["decayRate"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("角色级规则同样被规范化", async () => {
    const dir = makeWorldDir();
    try {
      await generateConfigs(
        {
          ...BASE_DESIGN,
          characters: [
            {
              ...BASE_DESIGN.characters[0],
              rules: { emotion: { decayRate: 5 } },
            },
          ],
        },
        dir,
        { originalPrompt: "测试" },
      );
      const files = readdirSync(join(dir, "config", "characters"));
      const char = JSON.parse(
        readFileSync(join(dir, "config", "characters", files[0]), "utf-8"),
      );
      expect(char.rules.emotion.decayRate).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("拼错的键不会被写进 world.json（它本来就会被忽略）", async () => {
    const { dir, world } = await writeWorld({
      ...BASE_DESIGN,
      rules: { emotion: { decayRat: 0.5 } },
    });
    try {
      // 不该存在的键不能进 world.json —— 进了就说明 world.json
      // 里躺着一个「看起来在配、其实没生效」的旋钮
      expect(world.rules?.emotion?.decayRat).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
