import { describe, it, expect } from "vitest";
import { normalizeWorldDesign } from "./world-design-utils.mjs";
import { generateConfigs } from "./config-generator.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * 阶段 2.5 的 orchestrator 侧 —— 世界规则从设计流到 world.json。
 *
 * 规则要在三个地方同时成立：
 * 1. **设计流程**能产出规则（世界级 + 角色级）
 * 2. 归一化**不把它弄丢**（`normalizeWorldDesign` 只挑字段，容易漏）
 * 3. **写进 world.json**，且写盘在插件钩子之后（钩子改的规则也得落盘）
 *
 * 第 2 条是重点 —— 归一化是显式构造返回值的，
 * 忘了加 `rules` 的话规则就静默消失了，而且不报错。
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
  const dir = mkdtempSync(join(tmpdir(), "worldx-rules-"));
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

describe("设计流程里的世界规则", () => {
  it("世界级规则被归一化保留", () => {
    const design = normalizeWorldDesign({
      ...BASE_DESIGN,
      rules: { emotion: { decayRate: 0.8 } },
    });
    expect(design.rules).toEqual({ emotion: { decayRate: 0.8 } });
  });

  it("角色级规则被归一化保留", () => {
    const design = normalizeWorldDesign({
      ...BASE_DESIGN,
      characters: [
        {
          ...BASE_DESIGN.characters[0],
          rules: { memory: { recencyDecayRate: 0.3 } },
        },
      ],
    });
    expect((design.characters[0] as any).rules).toEqual({
      memory: { recencyDecayRate: 0.3 },
    });
  });

  it("没有规则时是 null（不是 undefined —— 写盘要写成 null，跟 economics 一致）", () => {
    const design = normalizeWorldDesign(BASE_DESIGN);
    expect(design.rules).toBeNull();
  });

  it("规则不是对象时归一化成 null", () => {
    expect(normalizeWorldDesign({ ...BASE_DESIGN, rules: "垃圾" }).rules).toBeNull();
    expect(normalizeWorldDesign({ ...BASE_DESIGN, rules: [] }).rules).toBeNull();
    expect(normalizeWorldDesign({ ...BASE_DESIGN, rules: 42 }).rules).toBeNull();
  });
});

describe("规则写进 world.json", () => {
  it("世界级规则写进 world.json 的 rules 段", async () => {
    const dir = makeWorldDir();
    try {
      await generateConfigs(
        {
          ...BASE_DESIGN,
          rules: { emotion: { decayRate: 0.8 } },
        },
        dir,
        { originalPrompt: "测试" },
      );
      const world = JSON.parse(
        readFileSync(join(dir, "config", "world.json"), "utf-8"),
      );
      expect(world.rules).toEqual({ emotion: { decayRate: 0.8 } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("角色级规则写进角色的配置文件", async () => {
    const dir = makeWorldDir();
    try {
      await generateConfigs(
        {
          ...BASE_DESIGN,
          characters: [
            {
              ...BASE_DESIGN.characters[0],
              rules: { memory: { recencyDecayRate: 0.3 } },
            },
          ],
        },
        dir,
        { originalPrompt: "测试" },
      );
      const world = JSON.parse(
        readFileSync(join(dir, "config", "world.json"), "utf-8"),
      );
      expect(world.locations.length).toBeGreaterThan(0);
      // 角色文件名是 hash，列目录找
      const files = readdirSync(join(dir, "config", "characters"));
      expect(files.length).toBeGreaterThan(0);
      const char = JSON.parse(
        readFileSync(join(dir, "config", "characters", files[0]), "utf-8"),
      );
      expect(char.rules).toEqual({ memory: { recencyDecayRate: 0.3 } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("没有规则时 world.json 的 rules 是 null", async () => {
    const dir = makeWorldDir();
    try {
      await generateConfigs(BASE_DESIGN, dir, { originalPrompt: "测试" });
      const world = JSON.parse(
        readFileSync(join(dir, "config", "world.json"), "utf-8"),
      );
      expect(world.rules).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("插件在 extendWorldConfig 里加的规则也会落盘", async () => {
    const dir = makeWorldDir();
    try {
      await generateConfigs(BASE_DESIGN, dir, {
        originalPrompt: "测试",
        extendConfig: async (bundle: any) => ({
          ...bundle,
          worldConfig: {
            ...bundle.worldConfig,
            rules: { emotion: { decayRate: 0.3 } },
          },
        }),
      });
      const world = JSON.parse(
        readFileSync(join(dir, "config", "world.json"), "utf-8"),
      );
      // 钩子在写盘之前跑 —— 插件改的规则不能丢
      expect(world.rules).toEqual({ emotion: { decayRate: 0.3 } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
